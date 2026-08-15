"use server";

import { headers } from "next/headers";
import { screenContent } from "@/lib/content-filter";
import { db } from "@/lib/db";
import { FORK_POINT_ID } from "@/lib/fork-point";
import { tryConsumeFreeBootForIp } from "@/lib/free-boot-cap";
import {
  attachPreviewToPost,
  firstLinkIn,
  hasPreview,
  savePreview,
  urlHash,
} from "@/lib/link-preview-store";
import { verifyPaidPost } from "@/lib/paid-post";
import { isPaidPostingEnabled, MIN_ECONOMIC_OUTPUT_SATS } from "@/lib/post-economics";
import { rateLimit } from "@/lib/rate-limit";
import {
  FREE_BOOT_COST_SATS,
  hasDailyBudget,
  POST_LOG_COST_SATS,
  recordDailySpend,
} from "@/lib/server-spend-budget";
import { canonicalTicker, distinctTickers, isValidTicker, ROOT_TICKER } from "@/lib/ticker";
import { generateAnonName } from "@/lib/utils";

async function getBsvSdk() {
  const { PublicKey, Signature } = await import("@bsv/sdk");
  return { PublicKey, Signature };
}

import { sweepOrphans } from "@/services/bsv/anchor-sweep";
import { logPostOnChain } from "@/services/bsv/onchain";
import { getServerAddress, isServerSpendDisabled } from "@/services/bsv/wallet";
import { executeBoot } from "@/services/fairness/boot-orchestrator";
import { getBootPrice, getBootPriceForUser } from "@/services/fairness/pricing";
import { unfurl } from "@/services/link-unfurl";
import type { BootboardData, BootboardHistoryRow, BootboardRow, Post } from "@/types";

export interface CreatePostResult {
  ok: boolean;
  reason?:
    | "bad_input"
    | "missing_pubkey"
    | "rate_limited"
    | "daily_limit"
    | "paused"
    | "invalid_signature"
    | "rejected_content"
    | "invalid_parent"
    /** Paid posting is on and no funded transaction was supplied. */
    | "payment_required"
    /** A transaction was supplied but does not do what it claims. */
    | "invalid_payment";
}

/**
 * Resolve a reply's thread root, or null if the parent does not exist.
 *
 * ⚠ THE PARENT MUST BE LOOKED UP, NOT TRUSTED. `parent_id` arrives from the
 * client and is NOT part of the signed message (the signature covers post
 * content only). A parent id pointing at nothing would create a post that
 * belongs to no thread and can never be rendered — invisible in the root feed
 * because it has a parent, and absent from every thread view because its root
 * points nowhere.
 *
 * Returns the root to store: the parent's own root, or the parent itself if the
 * parent is a root. That is what keeps a reply five levels down carrying the
 * same `root_id` as the thread's first post, so thread reads stay a single
 * indexed lookup instead of a recursive walk.
 */
function resolveThreadRoot(parentId: number): number | null {
  const parent = db.prepare("SELECT id, root_id FROM posts WHERE id = ?").get(parentId) as
    | { id: number; root_id: number | null }
    | undefined;
  if (!parent) return null;
  return parent.root_id ?? parent.id;
}

export async function createPost(formData: FormData): Promise<CreatePostResult> {
  const content = formData.get("content");
  if (typeof content !== "string" || content.trim().length === 0)
    return { ok: false, reason: "bad_input" };
  if (content.length > 1000) return { ok: false, reason: "bad_input" };

  const author = formData.get("author");
  const authorName =
    typeof author === "string" && /^anon_[a-z0-9]{4}$/.test(author) ? author : generateAnonName();

  const signature = formData.get("signature");
  const pubkey = formData.get("pubkey");

  if (typeof pubkey !== "string" || pubkey.trim().length === 0)
    return { ok: false, reason: "missing_pubkey" };

  const rl = rateLimit(`createPost:${pubkey}`, { limit: 10, windowMs: 60_000 });
  if (!rl.success) return { ok: false, reason: "rate_limited" };

  if (typeof signature !== "string") return { ok: false, reason: "invalid_signature" };
  try {
    const { PublicKey, Signature } = await getBsvSdk();
    const messageBytes = Array.from(new TextEncoder().encode(content.trim()));
    const verified = PublicKey.fromString(pubkey).verify(
      messageBytes,
      Signature.fromDER(signature, "hex")
    );
    if (!verified) return { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  // Pre-publish content screen (Phase 3, thin-core, illegal-floor only). This is the
  // ONLY point that can stop content reaching the immutable chain — the OP_RETURN is
  // broadcast fire-and-forget right after the insert below. Best-effort + extensible;
  // permissive when CONTENT_DENYLIST is unset. See lib/content-filter.ts.
  if (!screenContent(content.trim()).ok) return { ok: false, reason: "rejected_content" };

  // Phase 4 abuse/cost gates — ALL run BEFORE the DB insert, so a refused post is
  // never inserted (the all-posts-on-chain invariant: never store a post we won't
  // fund on-chain). Run after the content screen so a rejected-content attempt
  // doesn't burn a legit user's daily cap.
  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    hdrs.get("x-real-ip")?.trim() ||
    "unknown";
  const envPostIpLimit = Number(process.env.ONCHAIN_POST_IP_LIMIT);
  const postIpDailyLimit =
    Number.isFinite(envPostIpLimit) && envPostIpLimit > 0 ? envPostIpLimit : 200;
  const ipRl = rateLimit(`postIp:${ip}`, { limit: postIpDailyLimit, windowMs: 24 * 60 * 60_000 });
  if (!ipRl.success) return { ok: false, reason: "daily_limit" };

  // Kill-switch + daily spend ceiling: REFUSE rather than insert-off-chain (a
  // post we can't fund on-chain must not exist). The durable sweep still anchors
  // already-accepted posts; these gates only block NEW acceptance.
  if (isServerSpendDisabled()) return { ok: false, reason: "paused" };
  if (!hasDailyBudget(POST_LOG_COST_SATS)) return { ok: false, reason: "paused" };

  // Threading (THREADS.md). A reply carries its parent and the thread root; a new
  // thread is its own root, which cannot be known until the row exists — hence the
  // insert-then-update inside one transaction below.
  const rawParent = formData.get("parent_id");
  let parentId: number | null = null;
  if (typeof rawParent === "string" && rawParent.trim() !== "") {
    const n = Number(rawParent);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: "invalid_parent" };
    parentId = n;
  }

  let rootId: number | null = null;
  if (parentId !== null) {
    rootId = resolveThreadRoot(parentId);
    if (rootId === null) return { ok: false, reason: "invalid_parent" };
  }

  // One transaction: a root post's own id is its root, so the row must exist
  // before root_id can be set. Splitting these would leave a window where a
  // crash yields a permanently unrooted post — the exact state the migration's
  // backfill had to clean up once already.
  const insertPost = db.transaction(
    (args: {
      content: string;
      author: string;
      sig: string | null;
      pk: string | null;
      parent: number | null;
      root: number | null;
      /** Set only for a PAID post — the inscription is already on-chain, so the
       *  outpoint is known before the row exists and there is nothing to sweep. */
      txId: string | null;
      vout: number | null;
    }): number => {
      const res = db
        .prepare(
          "INSERT INTO posts (content, author_name, signature, pubkey, parent_id, root_id, tx_id, vout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          args.content,
          args.author,
          args.sig,
          args.pk,
          args.parent,
          args.root,
          args.txId,
          args.vout
        );
      const id = res.lastInsertRowid as number;
      if (args.root === null) {
        db.prepare("UPDATE posts SET root_id = id WHERE id = ?").run(id);
      }
      return id;
    }
  );

  // ── Paid posting ─────────────────────────────────────────────────────────
  // When enabled the AUTHOR funds and broadcasts their own inscription, so the
  // server verifies a transaction instead of paying for one. Everything above
  // (signature, content screen, rate limits, parent resolution) is unchanged and
  // still runs first — paying does not buy an exemption from any of it.
  let paidTxId: string | null = null;
  let paidVout: number | null = null;
  if (isPaidPostingEnabled()) {
    const rawTx = formData.get("raw_tx");
    if (typeof rawTx !== "string" || rawTx.trim() === "") {
      // ⚠ REFUSE rather than falling back to the free server-funded path. A
      // fallback would make the gate meaningless: anyone could post for free by
      // omitting a field.
      return { ok: false, reason: "payment_required" };
    }

    let authorAddress: string;
    try {
      const { PublicKey } = await getBsvSdk();
      authorAddress = PublicKey.fromString(pubkey).toAddress().toString();
    } catch {
      return { ok: false, reason: "missing_pubkey" };
    }

    const verdict = verifyPaidPost({
      rawTx: rawTx.trim(),
      content: content.trim(),
      authorAddress,
      platformAddress: getServerAddress(),
      // ⚠ A FLOOR, NOT THE QUOTED PRICE. The author has ALREADY broadcast and
      // already paid by the time we see this — rejecting for a few satoshis of
      // legitimate fee drift would take their money and give them no post. The
      // floor only has to stop a post that paid the platform nothing.
      minPlatformSats: MIN_ECONOMIC_OUTPUT_SATS,
    });
    if (!verdict.ok) return { ok: false, reason: "invalid_payment" };

    // Replay: the same broadcast must not mint two posts.
    const seen = db.prepare("SELECT id FROM posts WHERE tx_id = ? LIMIT 1").get(verdict.txid) as
      | { id: number }
      | undefined;
    if (seen) return { ok: false, reason: "invalid_payment" };

    paidTxId = verdict.txid;
    paidVout = verdict.vout;
  }

  const postId = insertPost({
    content: content.trim(),
    author: authorName,
    sig: typeof signature === "string" ? signature : null,
    pk: typeof pubkey === "string" ? pubkey : null,
    parent: parentId,
    root: rootId,
    txId: paidTxId,
    vout: paidVout,
  });

  // Claim any `$Ticker` in the post — FIRST CLAIM WINS, enforced by the PRIMARY
  // KEY (see applyTickerMigration). Synchronous and inside the request, unlike
  // the on-chain log and the unfurl: those are caches of work that can be redone,
  // whereas a claim decides who owns a name and a race would hand it to whoever
  // the event loop happened to favour.
  registerTickers(postId, rootId ?? postId, parentId, content.trim(), pubkey);

  // Record the mention edges this post creates. Separate from the claim above:
  // claiming is first-wins and most mentions claim nothing, but EVERY mention
  // counts toward supply — including one of a name somebody else already holds,
  // and including one of a RESERVED name, which claims nothing but was still
  // said. See TOKENS.md "a tag is a MENTION WITH A TARGET".
  recordTickerMentions(postId, content.trim(), pubkey);

  // Fire-and-forget: log on-chain, update tx_id if successful
  const trimmedContent = content.trim();
  const sigStr = typeof signature === "string" ? signature : null;
  const pkStr = typeof pubkey === "string" ? pubkey : null;

  // A paid post is ALREADY on-chain and already owned — anchoring it again
  // would spend server funds to duplicate a record the author paid for, and the
  // sweep would keep retrying a post that already has a tx_id.
  if (paidTxId === null)
    logPostOnChain({
      id: postId,
      content: trimmedContent,
      author: authorName,
      signature: sigStr,
      pubkey: pkStr,
      parent: parentId,
    })
      .then((txid) => {
        if (txid) {
          db.prepare("UPDATE posts SET tx_id = ? WHERE id = ?").run(txid, postId);
          recordDailySpend(POST_LOG_COST_SATS);
        } else {
          console.error(`OpenBook: on-chain logging returned null for post ${postId}`);
        }
      })
      .catch((e) => {
        console.error(`OpenBook: on-chain logging failed for post ${postId}`, e);
      });

  // Durable guarantee: drain any older un-anchored post (this one is too fresh
  // to be swept — see anchor-sweep MIN_AGE). Fire-and-forget, single-flight.
  void sweepOrphans();

  // Fire-and-forget: unfurl the first link so the feed can show a preview card.
  // Deliberately NOT awaited — an unfurl is a network round-trip to a stranger's
  // server, and blocking post creation on it would put someone else's latency
  // (and downtime) directly in front of the compose box. The post is already
  // committed; the preview attaches when it arrives and the feed poll picks it up.
  void unfurlFirstLink(postId, trimmedContent);

  return { ok: true };
}

/**
 * Record a post's ticker claims. Never throws — a failure here must not lose the
 * post, which is already committed.
 *
 * `INSERT OR IGNORE` is the whole first-claim-wins rule: the PRIMARY KEY on
 * `symbol` rejects a later claimant silently, so no read-then-write race exists
 * and no application-level check is needed.
 */
/**
 * Record the untargeted mention edges a post's text creates.
 *
 * ⚠ NEVER THROWS INTO THE POST PATH. A mention is a derived record; the post and
 * its on-chain anchor are the durable facts. Failing the insert must not fail
 * the post — the same reasoning that makes `registerTickers` swallow its errors.
 *
 * Targeted edges (`target_type` 'post' / 'ticker' — tagging) are NOT written
 * here and have no writer yet: tagging is gated on paid posting. The columns
 * exist so that gate opens onto a schema that already fits.
 */
function recordTickerMentions(
  postId: number,
  content: string,
  pubkey: FormDataEntryValue | null
): void {
  try {
    const symbols = distinctTickers(content);
    if (!symbols.length) return;
    const pk = typeof pubkey === "string" ? pubkey : null;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, pubkey, target_type)
       VALUES (?, ?, ?, 'none')`
    );
    const all = db.transaction(() => {
      for (const symbol of symbols) insert.run(symbol, postId, pk);
    });
    all();
  } catch (e) {
    console.error("OpenBooks: failed to record ticker mentions", e);
  }
}

function registerTickers(
  postId: number,
  rootId: number,
  parentPostId: number | null,
  content: string,
  pubkey: FormDataEntryValue | null
): void {
  try {
    const symbols = distinctTickers(content);
    if (!symbols.length) return;

    // The parent ticker is the one owned by the thread this claim was made IN,
    // resolved BEFORE any re-rooting below — afterwards this post owns its own
    // root and the enclosing thread is no longer reachable from it.
    const enclosing = db
      .prepare("SELECT symbol FROM tickers WHERE root_id = ? ORDER BY post_id ASC LIMIT 1")
      .get(rootId) as { symbol: string } | undefined;
    const parent = enclosing?.symbol ?? ROOT_TICKER;

    const insert = db.prepare(
      "INSERT OR IGNORE INTO tickers (symbol, post_id, root_id, pubkey, parent_symbol) VALUES (?, ?, ?, ?, ?)"
    );
    const pk = typeof pubkey === "string" ? pubkey : null;

    const claimAll = db.transaction(() => {
      // ⚠ A NEW TICKER STARTS A NEW THREAD. Naming an unclaimed ticker inside an
      // existing thread must not point back at the thread it was named in — the
      // ticker is a NEW idea branching off, and clicking it has to open that idea
      // rather than re-open its parent. So the claiming post is RE-ROOTED to
      // itself and becomes the root of a child thread.
      //
      // `parent_id` is untouched, so the reply lineage still records where the
      // branch came from; `root_id` answers the different question of which
      // thread — which token — a post belongs to. That split is what keeps
      // `WHERE root_id = ?` one indexed scan on the allocation path.
      // ⚠ RESERVED NAMES ARE SKIPPED, NOT REFUSED. The post itself still stands —
      // writing `$Water` must not fail to publish just because that name is held
      // open. It simply claims nothing, exactly as it already does when somebody
      // else got there first. Refusing the post instead would make a reservation
      // list into a word filter, which is a different and much worse thing.
      const isReserved = db.prepare("SELECT 1 FROM reserved_tickers WHERE symbol = ?");

      let claimedAny = false;
      for (const symbol of symbols) {
        if (isReserved.get(symbol)) continue;
        const res = insert.run(
          symbol,
          postId,
          postId, // this post roots its own thread — see the note above
          pk,
          symbol === ROOT_TICKER ? null : parent
        );
        if (res.changes > 0) claimedAny = true;
      }
      // Only re-root when a claim actually landed AND this post is a reply. A
      // ticker that was already claimed changes nothing, and a root post is
      // already its own root.
      if (claimedAny && parentPostId !== null) {
        db.prepare("UPDATE posts SET root_id = id WHERE id = ?").run(postId);
      }
    });
    claimAll();
  } catch (e) {
    console.error(`OpenBook: ticker registration failed for post ${postId}`, e);
  }
}

/**
 * Where a `$Ticker` points — the thread that claimed it, or null if unclaimed.
 *
 * Unclaimed is a normal, expected answer: someone can write `$Whatever` in a post
 * that has not been made yet, or refer to a name nobody has taken. The UI renders
 * those as plain text rather than a dead link.
 */
export async function resolveTickers(
  symbols: string[]
): Promise<Record<string, { root_id: number; post_id: number }>> {
  const wanted = symbols.map(canonicalTicker).filter(isValidTicker);
  if (!wanted.length) return {};
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT symbol, root_id, post_id FROM tickers WHERE symbol IN (${placeholders})`)
    .all(...wanted) as { symbol: string; root_id: number; post_id: number }[];
  return Object.fromEntries(
    rows.map((r) => [r.symbol, { root_id: r.root_id, post_id: r.post_id }])
  );
}

/**
 * A ticker's ancestry, root-first: `["OPENBOOK","TEST"]` for `$OpenBooks/$Test`.
 *
 * Depth-capped and cycle-guarded. `parent_symbol` is written once at claim time and
 * never edited, so a loop should be impossible — but this walk runs on a render
 * path, and "impossible" data is exactly what hangs a request.
 */
export async function getTickerPath(symbol: string): Promise<string[]> {
  const start = canonicalTicker(symbol);
  if (!isValidTicker(start)) return [];
  const stmt = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?");
  const path: string[] = [start];
  const seen = new Set<string>([start]);
  let current = start;
  for (let depth = 0; depth < 16; depth++) {
    const row = stmt.get(current) as { parent_symbol: string | null } | undefined;
    const parent = row?.parent_symbol;
    if (!parent || seen.has(parent)) break;
    path.unshift(parent);
    seen.add(parent);
    current = parent;
  }
  return path;
}

/**
 * How widely a ticker is used: how many DISTINCT THREADS mention it.
 *
 * ⚠ DISTINCT THREADS, NOT RAW MENTIONS. Raw mentions are free and unbounded, so
 * anyone could inflate a number that readers treat as significance. Counting
 * threads at least ties the figure to separate conversations. This is DISPLAY
 * ONLY and must never feed allocation — mentions are free, and anything free that
 * confers value destroys the anchor (TOKENS.md).
 */
export async function getTickerUsage(symbols: string[]): Promise<Record<string, number>> {
  const wanted = symbols.map(canonicalTicker).filter(isValidTicker);
  if (!wanted.length) return {};
  const out: Record<string, number> = {};
  const stmt = db.prepare(
    "SELECT COUNT(DISTINCT root_id) AS n FROM posts WHERE UPPER(content) LIKE ?"
  );
  for (const sym of wanted) {
    // `$SYM` followed by a non-alphanumeric or end — mirrors the parse rule's word
    // boundary closely enough for a display count.
    const row = stmt.get(`%$${sym}%`) as { n: number };
    out[sym] = row?.n ?? 0;
  }
  return out;
}

export async function getThreadTicker(rootId: number): Promise<string | null> {
  if (!Number.isInteger(rootId) || rootId <= 0) return null;
  const row = db
    .prepare(
      "SELECT symbol FROM tickers WHERE root_id = ? ORDER BY post_id ASC, symbol ASC LIMIT 1"
    )
    .get(rootId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}

/**
 * What one author holds in one thread, counted in posts.
 *
 * ⚠ THIS IS THE CONTRIBUTION RECORD, NOT A TOKEN BALANCE. Nothing is minted
 * (TOKENS.md: no mint, no fee, no supply), so there is no ledger to read. Under
 * one-token-per-contribution the two would coincide — your holding in a thread
 * IS the number of posts you put in it — which is exactly why this can be shown
 * now and why it must never be *called* a balance in the UI. If minting ever
 * ships, this becomes a read of the real thing rather than a stand-in, and every
 * caller keeps working.
 *
 * Keyed on `pubkey`, matching `fairness/weights.ts`. The address is derived from
 * the pubkey, so counting by pubkey is the same partition with one less
 * conversion that could disagree.
 */
export async function getThreadShare(
  rootId: number,
  pubkey: string
): Promise<{ mine: number; total: number }> {
  if (!Number.isInteger(rootId) || rootId <= 0 || !pubkey) return { mine: 0, total: 0 };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pubkey = ? THEN 1 ELSE 0 END) AS mine
         FROM posts WHERE root_id = ?`
    )
    .get(pubkey, rootId) as { total: number; mine: number | null };
  return { mine: row?.mine ?? 0, total: row?.total ?? 0 };
}

/**
 * Headline counts for one thread — what a social card can say about it.
 *
 * `tokens` is the post count, because a post IS a token (TOKENS.md). `replies`
 * is that minus the root, so the two numbers are consistent by construction
 * rather than by two queries that could disagree.
 */
/**
 * How many units of each ticker exist — one per post that NAMES it.
 *
 * ⚠ MENTIONS, NOT THREAD SIZE. An earlier version counted posts in the ticker's
 * own thread, which produced (100%) on every mention of a single-post token —
 * including on a post that merely CITES it and is therefore in a different
 * thread holding none of it. Two posts saying `$branch` both read 100%, which is
 * both arithmetically impossible and the opposite of what the model says.
 *
 * Counting mentions is the settled citation model made visible: a post is a
 * 1-of-1 that becomes a 1-of-2 when quoted, and the QUOTER holds the new unit
 * (TOKENS.md). Two posts naming `$branch` → two units → 50% each.
 *
 * ⚠ DISPLAY ONLY. Nothing is minted here and this must NEVER feed allocation:
 * mentions are free, and anything free that confers value destroys the anchor.
 * Real minting stays gated on paid posting. This shows what the supply WOULD be,
 * from data that already exists.
 *
 * ⚠ THE LIKE IS A PREFILTER, NOT THE ANSWER. `%$BRANCH%` also matches `$BRANCHES`
 * and `x$BRANCH`, so every candidate is re-checked with `distinctTickers` — the
 * same matcher that decides what gets CLAIMED. A count that disagreed with the
 * parse rule would attribute one token's supply to another's name.
 */
export type NymResult =
  | { ok: true; symbol: string }
  | { ok: false; reason: "invalid" | "taken" | "post_failed" };

/**
 * Adopt a `$Nym` — a public name for an identity.
 *
 * ⚠ CLAIMING A NYM POSTS IT, and that is the whole design. A ticker's row carries
 * `post_id`/`root_id` NOT NULL because a ticker names a THREAD; letting a nym be
 * registered from a settings screen would mean either relaxing that invariant or
 * inventing a second kind of ticker that has no content behind it. Posting the
 * claim keeps one rule: **every name on this board was claimed by somebody
 * writing something.** It also means a nym's thread IS that person's profile —
 * the place their name points at — for free, with no new concept.
 *
 * It follows that a nym obeys first-claim-wins through the same PRIMARY KEY as
 * every other symbol, is anchored on-chain like every other post, and can be
 * cited and minted into by anyone. A name you go by is not a privileged object.
 *
 * The post is signed by the caller exactly as any post is — this delegates to
 * `createPost`, so the signature check, the content screen, the rate limits and
 * the on-chain anchoring are the ones already in place rather than a second copy.
 */
export async function claimNym(formData: FormData): Promise<NymResult> {
  const raw = formData.get("symbol");
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const symbol = canonicalTicker(raw.trim().replace(/^\$+/, ""));
  if (!isValidTicker(symbol)) return { ok: false, reason: "invalid" };

  const pubkey = formData.get("pubkey");
  if (typeof pubkey !== "string" || !pubkey) return { ok: false, reason: "invalid" };

  // Cheap pre-check so the common failure costs nothing. It is NOT the guard —
  // two people can pass this at once. The PRIMARY KEY below is what decides.
  const existing = db.prepare("SELECT symbol FROM tickers WHERE symbol = ?").get(symbol);
  if (existing) return { ok: false, reason: "taken" };

  // The claim goes through the ordinary post path, so the content the user signed
  // must be exactly what gets posted. The caller signs this same string.
  const result = await createPost(formData);
  if (!result.ok) return { ok: false, reason: "post_failed" };

  // The post may not have won the name — another claim can land in between, and
  // `registerTickers` uses INSERT OR IGNORE. Read back who actually holds it.
  const owner = db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(symbol) as
    | { pubkey: string | null }
    | undefined;
  if (!owner || owner.pubkey !== pubkey) return { ok: false, reason: "taken" };

  // One identity, one public name: adopting a new one replaces the old rather
  // than accumulating. The old ticker is still owned — only the display changes.
  //
  // ⚠ DERIVED HERE, NEVER ACCEPTED. The address is computed from the pubkey the
  // ticker claim was already verified against — taking one from the caller would
  // let anybody attach their name to somebody else's spending.
  let address: string | null = null;
  try {
    const { PublicKey } = await getBsvSdk();
    address = PublicKey.fromString(pubkey).toAddress().toString();
  } catch {
    // A nym with no address still works everywhere it is keyed on pubkey; only
    // the spender lookup degrades, which is better than refusing the claim.
    address = null;
  }

  // ⚠ BOTH CONSTRAINTS HAVE TO BE HANDLED, not just the pubkey one. `nyms` is
  // unique on symbol as well, and an upsert keyed on pubkey alone throws a raw
  // SQLite error the moment that symbol is already recorded against SOMEBODY
  // ELSE — which is reachable, because a ticker can change hands while the old
  // holder's nym row still points at it. A test hit exactly that. The caller's
  // ownership of the ticker was verified above, so clearing a stale row for the
  // symbol is the correct resolution rather than a failure; doing both in one
  // transaction stops a crash in between leaving an identity with no name at all.
  db.transaction(() => {
    db.prepare("DELETE FROM nyms WHERE symbol = ? AND pubkey <> ?").run(symbol, pubkey);
    db.prepare(
      `INSERT INTO nyms (pubkey, symbol, address) VALUES (?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET symbol = excluded.symbol, address = excluded.address`
    ).run(pubkey, symbol, address);
  })();

  return { ok: true, symbol };
}

/** The public name an identity goes by, or null if it is still anonymous. */
export async function getNym(pubkey: string): Promise<string | null> {
  if (!pubkey) return null;
  const row = db.prepare("SELECT symbol FROM nyms WHERE pubkey = ?").get(pubkey) as
    | { symbol: string }
    | undefined;
  return row?.symbol ?? null;
}

/**
 * Public names for many identities at once — for rendering a feed.
 *
 * One query for every author on screen, for the same reason `getTickerSupply`
 * takes a list: a lookup per post would turn scrolling into a query storm.
 */
export async function getNyms(pubkeys: string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(pubkeys.filter(Boolean))].slice(0, 200);
  if (!wanted.length) return {};
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT pubkey, symbol FROM nyms WHERE pubkey IN (${placeholders})`)
    .all(...wanted) as { pubkey: string; symbol: string }[];
  return Object.fromEntries(rows.map((r) => [r.pubkey, r.symbol]));
}

/** True if this name is being held open and cannot be claimed by a post. */
export async function isReservedTicker(symbol: string): Promise<boolean> {
  const sym = canonicalTicker(symbol);
  if (!isValidTicker(sym)) return false;
  return Boolean(db.prepare("SELECT 1 FROM reserved_tickers WHERE symbol = ?").get(sym));
}

/**
 * Hold names open so they cannot be claimed by an ordinary post.
 *
 * ⚠ NEVER TAKES A NAME SOMEBODY ALREADY HAS. Already-claimed symbols are skipped
 * and reported back, because reserving one retroactively would confiscate a name
 * claimed under the rules as they stood — and the whole point of first-claim-wins
 * is that it cannot be revised afterwards.
 *
 * Returns what actually happened rather than a count, so a caller reserving ten
 * thousand words can see which ones were already gone.
 */
export async function reserveTickers(
  symbols: string[],
  reason = "namespace"
): Promise<{ reserved: string[]; alreadyClaimed: string[] }> {
  const wanted = [...new Set(symbols.map(canonicalTicker).filter(isValidTicker))];
  const reserved: string[] = [];
  const alreadyClaimed: string[] = [];
  const taken = db.prepare("SELECT 1 FROM tickers WHERE symbol = ?");
  const put = db.prepare("INSERT OR IGNORE INTO reserved_tickers (symbol, reason) VALUES (?, ?)");
  db.transaction(() => {
    for (const sym of wanted) {
      if (taken.get(sym)) {
        alreadyClaimed.push(sym);
        continue;
      }
      put.run(sym, reason);
      reserved.push(sym);
    }
  })();
  return { reserved, alreadyClaimed };
}

/**
 * Release names back to the namespace — the path that makes this a temporary
 * measure rather than a permanent enclosure. Returns how many were let go.
 */
export async function releaseTickers(symbols: string[]): Promise<number> {
  const wanted = [...new Set(symbols.map(canonicalTicker).filter(isValidTicker))];
  if (!wanted.length) return 0;
  const placeholders = wanted.map(() => "?").join(",");
  const res = db
    .prepare(`DELETE FROM reserved_tickers WHERE symbol IN (${placeholders})`)
    .run(...wanted);
  return res.changes;
}

export interface TickerHit {
  symbol: string;
  /** Ancestry, root-first — the same path the thread header renders. */
  path: string[];
  root_id: number;
  /** Units in circulation: posts that NAME this ticker. The economic weight. */
  supply: number;
  /** The claiming post's opening words, so a result is recognisable. */
  excerpt: string;
}

/**
 * Find tickers by name, ranked by economic weight.
 *
 * ⚠ THIS IS THE INDEX, AND IT DID NOT EXIST. Until now a `$Ticker` could be
 * claimed, priced and linked, but never FOUND — no search by name, by popularity,
 * or at all. A keyword index you cannot query is not an index, which is the gap
 * between what this project is and what DIRECTION.md says it is for.
 *
 * ⚠ RANKED BY SUPPLY, NOT BY RECENCY OR TEXT SCORE. Supply is the number of posts
 * that named a ticker — i.e. how many people paid attention to it — so ordering
 * by it makes the ranking signal the ECONOMIC one rather than something inferred.
 * That is the whole thesis: a signal that costs something to produce cannot be
 * manufactured cheaply. Do not "improve" this by mixing in engagement heuristics
 * that are free to generate.
 *
 * Prefix matches sort above interior matches AT EQUAL WEIGHT, because someone
 * typing "fore" wants `$Forest` before `$Wildfore` — but weight comes first, so
 * text shape can never outrank the economic signal.
 */
export async function searchTickers(query: string, limit = 30): Promise<TickerHit[]> {
  const q = canonicalTicker(query.trim().replace(/^\$+/, ""));
  if (!q) return [];
  const capped = Math.min(Math.max(1, limit), 100);

  const rows = db
    .prepare(
      `SELECT t.symbol AS symbol, t.root_id AS root_id, t.parent_symbol AS parent_symbol,
              p.content AS content
         FROM tickers t
         LEFT JOIN posts p ON p.id = t.post_id
        WHERE t.symbol LIKE ?
        LIMIT 300`
    )
    .all(`%${q}%`) as {
    symbol: string;
    root_id: number;
    parent_symbol: string | null;
    content: string | null;
  }[];
  if (!rows.length) return [];

  const supply = await getTickerSupply(rows.map((r) => r.symbol));

  // Ancestry walk, memoised — sibling tickers share ancestors, so the same chain
  // would otherwise be re-walked per hit.
  const parentStmt = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?");
  const cache = new Map<string, string[]>();
  const pathFor = (symbol: string): string[] => {
    const hit = cache.get(symbol);
    if (hit) return hit;
    const path: string[] = [symbol];
    const seen = new Set([symbol]);
    let cur = symbol;
    for (let d = 0; d < 16; d++) {
      const row = parentStmt.get(cur) as { parent_symbol: string | null } | undefined;
      const parent = row?.parent_symbol;
      if (!parent || seen.has(parent)) break;
      path.unshift(parent);
      seen.add(parent);
      cur = parent;
    }
    cache.set(symbol, path);
    return path;
  };

  return rows
    .map((r) => ({
      symbol: r.symbol,
      path: pathFor(r.symbol),
      root_id: r.root_id,
      supply: supply[r.symbol] ?? 0,
      excerpt: (r.content ?? "").slice(0, 140),
    }))
    .sort((a, b) => {
      // ⚠ WEIGHT FIRST, PREFIX ONLY AS A TIEBREAK. An earlier version sorted
      // prefix matches above everything, which meant an unknown `$Alpha` beat a
      // heavily-held `$Beta` for the query "a" — text shape outranking the
      // economic signal, which is the one thing this index is not supposed to
      // do. A test caught it.
      if (b.supply !== a.supply) return b.supply - a.supply;
      const aPrefix = a.symbol.startsWith(q) ? 0 : 1;
      const bPrefix = b.symbol.startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      // Alphabetical last, so equal-weight results have a stable order rather
      // than whatever the query planner happened to return.
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, capped);
}

/**
 * Every claimed ticker, heaviest first — the directory behind `/tickers`.
 *
 * Capped, and the cap is honest: this is the front page of the index, not an
 * export. `searchTickers` is how you reach past it.
 */
export async function listTickers(limit = 100): Promise<TickerHit[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const rows = db
    .prepare(
      `SELECT t.symbol AS symbol, t.root_id AS root_id, p.content AS content
         FROM tickers t
         LEFT JOIN posts p ON p.id = t.post_id
        LIMIT 500`
    )
    .all() as { symbol: string; root_id: number; content: string | null }[];
  if (!rows.length) return [];

  const supply = await getTickerSupply(rows.map((r) => r.symbol));
  const parentStmt = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?");
  const cache = new Map<string, string[]>();
  const pathFor = (symbol: string): string[] => {
    const hit = cache.get(symbol);
    if (hit) return hit;
    const path: string[] = [symbol];
    const seen = new Set([symbol]);
    let cur = symbol;
    for (let d = 0; d < 16; d++) {
      const row = parentStmt.get(cur) as { parent_symbol: string | null } | undefined;
      const parent = row?.parent_symbol;
      if (!parent || seen.has(parent)) break;
      path.unshift(parent);
      seen.add(parent);
      cur = parent;
    }
    cache.set(symbol, path);
    return path;
  };

  return rows
    .map((r) => ({
      symbol: r.symbol,
      path: pathFor(r.symbol),
      root_id: r.root_id,
      supply: supply[r.symbol] ?? 0,
      excerpt: (r.content ?? "").slice(0, 140),
    }))
    .sort((a, b) => b.supply - a.supply || a.symbol.localeCompare(b.symbol))
    .slice(0, capped);
}

export async function getTickerSupply(symbols: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(symbols.map(canonicalTicker).filter(isValidTicker))].slice(0, 200);
  if (!wanted.length) return {};

  // Reads the mention edge table (see applyTickerMentionMigration), NOT a
  // `LIKE '%$SYM%'` scan of post content.
  //
  // ⚠ THE SCAN IT REPLACED WAS CAPPED AT `LIMIT 500` AND SILENTLY WRONG ABOVE
  // IT. Supply is what ranks the public index, so the most-named tickers — the
  // ones the cap actually bit — were exactly the ones reported inaccurately.
  // It was also one query per symbol; this is one query for all of them.
  //
  // One unit per POST is enforced in the schema now (a partial unique index on
  // `(post_id, symbol)`), rather than by de-duplicating rows after reading them.
  const out: Record<string, number> = {};
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT symbol, COUNT(*) AS n
         FROM ticker_mentions
        WHERE symbol IN (${placeholders})
        GROUP BY symbol`
    )
    .all(...wanted) as { symbol: string; n: number }[];
  for (const r of rows) {
    if (r.n > 0) out[r.symbol] = r.n;
  }
  return out;
}

export async function getThreadStats(rootId: number): Promise<{ tokens: number; replies: number }> {
  if (!Number.isInteger(rootId) || rootId <= 0) return { tokens: 0, replies: 0 };
  const row = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE root_id = ?").get(rootId) as {
    n: number;
  };
  const tokens = row?.n ?? 0;
  return { tokens, replies: Math.max(0, tokens - 1) };
}

export interface PostingMode {
  /** True when the author must fund their own post. */
  paid: boolean;
  /** Where the markup must be paid. Null means at-cost (no fee output). */
  platformAddress: string | null;
  /** Markup percentage, so the client can quote the SAME price the server floors. */
  markupPercent: number;
}

/**
 * Whether posting costs the author money, and what it costs.
 *
 * ⚠ THE CLIENT CANNOT DECIDE THIS. `isPaidPostingEnabled()` and the platform
 * address are server state; a client that guessed would either charge a user for
 * a post the server accepts free, or build an unfunded transaction the server
 * then refuses AFTER it was broadcast — which spends their money for nothing.
 *
 * Exposes no secret: the platform address is a public destination that appears
 * in every paid transaction anyway.
 */
export async function getPostingMode(): Promise<PostingMode> {
  const paid = isPaidPostingEnabled();
  const raw = Number((process.env.POST_MARKUP_PERCENT ?? "").trim());
  return {
    paid,
    platformAddress: paid ? getServerAddress() : null,
    markupPercent: Number.isFinite(raw) && raw >= 0 ? raw : 10,
  };
}

export interface TickerHolder {
  pubkey: string;
  /** The holder's public name, or null if they have not claimed one. */
  nym: string | null;
  units: number;
}

export interface TickerLeaderboard {
  symbol: string;
  /** Ticker ancestry, root-first — the same path the index and wallet render. */
  path: string[];
  /** Every unit issued: the ticker's supply, and the split's denominator. */
  total: number;
  /** Units belonging to an identifiable holder. */
  attributed: number;
  /** Top holders, largest first. Capped — see the note on the cap below. */
  holders: TickerHolder[];
}

/**
 * Who holds a ticker, largest first.
 *
 * ⚠ THIS IS THE PAYOUT ROSTER, not a vanity chart. It is the same query the
 * top-100 split will run when a payment is routed (DECISIONS.md, *The split pays
 * the TOP 100 HOLDERS*), so publishing it makes the economics auditable BEFORE
 * any money moves through them — and any disagreement between this page and a
 * real payout is a bug in one of them rather than two independent guesses.
 *
 * ⚠ UNATTRIBUTED UNITS ARE REPORTED, NOT DROPPED. Genesis posts were
 * operator-attested and carry no pubkey, so a ticker can hold units with no
 * owner. Silently omitting them would make the listed shares fail to sum to
 * 100% with no explanation visible to the reader — so `total` counts every unit
 * and `attributed` counts the ones with a holder; the difference is the
 * unowned remainder, and the page says so.
 */
export async function getTickerLeaderboard(
  symbol: string,
  limit = 100
): Promise<TickerLeaderboard | null> {
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return null;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pubkey IS NOT NULL AND pubkey <> '' THEN 1 ELSE 0 END) AS attributed
         FROM ticker_mentions WHERE symbol = ?`
    )
    .get(canonical) as { total: number; attributed: number | null };
  if (!totals || totals.total === 0) return null;

  // The cap matches the split's 100. A leaderboard that listed more holders than
  // a payment can reach would advertise a share nobody can be paid.
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = db
    .prepare(
      `SELECT m.pubkey AS pubkey, COUNT(*) AS units, n.symbol AS nym
         FROM ticker_mentions m
         LEFT JOIN nyms n ON n.pubkey = m.pubkey
        WHERE m.symbol = ? AND m.pubkey IS NOT NULL AND m.pubkey <> ''
        GROUP BY m.pubkey
        ORDER BY units DESC, m.pubkey ASC
        LIMIT ?`
    )
    .all(canonical, capped) as { pubkey: string; units: number; nym: string | null }[];

  return {
    symbol: canonical,
    path: await getTickerPath(canonical),
    total: totals.total,
    attributed: totals.attributed ?? 0,
    holders: rows,
  };
}

export interface Holding {
  /**
   * `"name"` — a `$Ticker` you hold units of, measured as a share of every post
   * that named it. `"post"` — a post of yours that carries no name: a 1-of-1,
   * with no share to report.
   *
   * ⚠ THE TWO ARE NOT COMPARABLE, which is why they are labelled rather than
   * merged. Listing them in one column under one percentage is what made this
   * panel read as inconsistent: a named token's "50%" answered "how much of this
   * name is mine", while an unnamed post's "100%" only ever meant "I wrote it".
   */
  kind: "name" | "post";
  root_id: number;
  /** Ticker ancestry, root-first. Empty for a post-token. */
  path: string[];
  /** Post-tokens only — so an unnamed token is recognisable as something you wrote. */
  excerpt: string | null;
  /**
   * The on-chain txid of the token's genesis post — its DEFAULT NAME.
   *
   * ⚠ EVERY TOKEN HAS A NAME; most are unreadable. A post is a token, so it
   * needs an identifier whether or not anyone chose one, and the honest default
   * is the thing that already identifies it on-chain. That is precisely what a
   * `$Ticker` buys: a unique human-readable alias over an identifier nobody
   * could say out loud. Showing the txid rather than a friendly invented label
   * is what makes the value of naming visible.
   *
   * Null until the anchor lands (see `anchor-sweep`), where the row id stands in.
   */
  tx_id: string | null;
  /** Units this author holds — for a name, how many of their posts named it. */
  mine: number;
  /** Units issued — for a name, how many posts named it in total. */
  total: number;
}

/**
 * Every thread this author has contributed to, with their share of each.
 *
 * One aggregate query over the threads they appear in, rather than a query per
 * thread: this runs whenever the You modal opens, and a per-thread lookup would
 * turn a wallet panel into N round-trips for someone who posts a lot.
 *
 * Capped at 50. A cap is silent truncation, so it is ordered by holding size —
 * what falls off the end is the tail the reader cares least about, not an
 * arbitrary slice. See `getThreadShare` for why posts stand in for tokens.
 */
/** A post's first line of text, cut on a word boundary and marked as cut. */
const EXCERPT_MAX = 80;
function excerptOf(content: string): string {
  const flat = content.trim().replace(/\s+/g, " ");
  if (flat.length <= EXCERPT_MAX) return flat;
  const cut = flat.slice(0, EXCERPT_MAX);
  // Back up to the last space so the preview does not end mid-word. Only when
  // one is reasonably close, otherwise a long unbroken string (a URL) would be
  // cut to almost nothing.
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_MAX - 20 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

export async function getHoldings(pubkey: string): Promise<Holding[]> {
  if (!pubkey || typeof pubkey !== "string") return [];

  // ── Named tokens ──
  // Share of MENTIONS — the same denominator the feed prints beside a ticker and
  // that /tickers ranks on.
  //
  // ⚠ THIS USED TO COUNT THREAD MEMBERSHIP (`root_id`), AND THAT IS WHY THE
  // WALLET AND THE FEED DISAGREED. A claim RE-ROOTS its post, so only the very
  // first post to name a ticker joins that ticker's thread; every later post
  // naming it stays its own root. Thread size therefore froze while the mention
  // count kept climbing — the feed said `$MEMEPLEX (25%)` off four mentions
  // while the wallet said `2/2 100%` off two thread members. Both were
  // internally correct and they measured different things.
  const namedRows = db
    .prepare(
      `SELECT m.symbol AS symbol,
              SUM(CASE WHEN m.pubkey = ? THEN 1 ELSE 0 END) AS mine,
              COUNT(*) AS total,
              t.root_id AS root_id,
              (SELECT p.tx_id FROM posts p WHERE p.id = t.root_id) AS tx_id
         FROM ticker_mentions m
         JOIN tickers t ON t.symbol = m.symbol
        WHERE m.symbol IN (SELECT DISTINCT symbol FROM ticker_mentions WHERE pubkey = ?)
        GROUP BY m.symbol
        ORDER BY mine DESC, total DESC
        LIMIT 50`
    )
    .all(pubkey, pubkey) as {
    symbol: string;
    mine: number;
    total: number;
    root_id: number;
    tx_id: string | null;
  }[];

  // ── Post tokens ──
  // Posts of yours that carry no name at all. A post IS a token, so these belong
  // in the wallet — but they are 1-of-1s, and `NOT EXISTS (… ticker_mentions …)`
  // keeps a post that DID name something from appearing twice, once here and
  // once under the name it gave.
  const postRows = db
    .prepare(
      // EVERY post they wrote, replies included — one post, one token. Filtering
      // to thread roots would silently drop tokens the user owns.
      `SELECT p.id AS root_id, p.tx_id AS tx_id, p.content AS content
         FROM posts p
        WHERE p.pubkey = ?
          AND NOT EXISTS (SELECT 1 FROM ticker_mentions m WHERE m.post_id = p.id)
        ORDER BY p.id DESC
        LIMIT 50`
    )
    .all(pubkey) as { root_id: number; tx_id: string | null; content: string }[];

  if (!namedRows.length && !postRows.length) return [];

  // Ancestry walk, memoised across rows: sibling threads share ancestors, so the
  // same parent chain would otherwise be re-walked once per holding.
  const parentStmt = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?");
  const pathCache = new Map<string, string[]>();
  const pathFor = (symbol: string): string[] => {
    const cached = pathCache.get(symbol);
    if (cached) return cached;
    const path: string[] = [symbol];
    const seen = new Set<string>([symbol]);
    let current = symbol;
    // Same depth cap and cycle guard as getTickerPath, for the same reason:
    // "impossible" data is what hangs a render path.
    for (let depth = 0; depth < 16; depth++) {
      const row = parentStmt.get(current) as { parent_symbol: string | null } | undefined;
      const parent = row?.parent_symbol;
      if (!parent || seen.has(parent)) break;
      path.unshift(parent);
      seen.add(parent);
      current = parent;
    }
    pathCache.set(symbol, path);
    return path;
  };

  const names: Holding[] = namedRows.map((r) => ({
    kind: "name",
    root_id: r.root_id,
    path: pathFor(r.symbol),
    excerpt: null,
    tx_id: r.tx_id,
    mine: r.mine,
    total: r.total,
  }));

  const posts: Holding[] = postRows.map((r) => ({
    kind: "post",
    root_id: r.root_id,
    path: [],
    // Shown INSTEAD of the txid, which identified the token honestly but told
    // the holder nothing about which of their posts it was. The ellipsis marks
    // the cut — without it a truncated line just stops mid-word and reads as
    // corrupted text rather than a preview.
    excerpt: excerptOf(r.content),
    tx_id: r.tx_id,
    mine: 1,
    total: 1,
  }));

  // Names first: a share of something other people also named is the holding a
  // reader is looking for, and a 1-of-1 post is the long tail.
  return [...names, ...posts];
}

/**
 * Unfurl a post's first link and attach it. Never throws — it runs detached, so
 * a rejection here would be an unhandled rejection with nothing to catch it.
 */
async function unfurlFirstLink(postId: number, content: string): Promise<void> {
  try {
    const link = firstLinkIn(content);
    if (!link) return;

    // Cache hit — including a cached FAILURE — costs no outbound request. This is
    // what stops a hostile URL from being re-fetched every time it is posted.
    if (hasPreview(db, link)) {
      attachPreviewToPost(db, postId, urlHash(link));
      return;
    }

    const result = await unfurl(link);
    const hash = result.ok
      ? savePreview(db, {
          url: result.url,
          status: "ok",
          title: result.data.title,
          description: result.data.description,
          imageUrl: result.data.image,
          siteName: result.data.siteName,
        })
      : savePreview(db, { url: result.url, status: result.reason });

    // Attach even on failure: the row records that this URL was tried and what
    // happened, which is what makes the cache-hit path above meaningful.
    attachPreviewToPost(db, postId, hash);
  } catch (e) {
    console.error(`OpenBook: link unfurl failed for post ${postId}`, e);
  }
}

/**
 * The one SELECT every feed read is built from.
 *
 * ⚠ SIX COPIES OF THIS JOIN USED TO EXIST, and adding link previews would have
 * made it six places to keep in step. One constant instead: a column added here
 * reaches LIVE scroll-up, ORIGIN read-forward, polling and confirmation-refresh
 * at once, and none of them can quietly drift from the others.
 *
 * `p.*` carries the post's own columns (including `parent_id` / `root_id` /
 * `preview_hash`); the preview columns are aliased flat rather than nested
 * because better-sqlite3 returns rows, not object graphs. A post with no link,
 * or whose unfurl has not landed yet, simply has nulls — the LEFT JOIN never
 * drops a post.
 */
const POST_SELECT = `
  SELECT p.*,
         COALESCE(bc.boot_count, 0) as boot_count,
         COALESCE(rc.reply_count, 0) as reply_count,
         lp.url         as preview_url,
         lp.title       as preview_title,
         lp.description as preview_description,
         lp.image_url   as preview_image,
         lp.site_name   as preview_site_name,
         lp.status      as preview_status,
         ny.symbol      as author_nym
  FROM posts p
  LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
    ON bc.post_id = p.id
  LEFT JOIN (
    SELECT root_id, COUNT(*) as reply_count FROM posts WHERE parent_id IS NOT NULL GROUP BY root_id
  ) rc
    ON rc.root_id = p.id
  LEFT JOIN link_previews lp
    ON lp.url_hash = p.preview_hash
  -- The author's public name, joined LIVE rather than denormalised onto the
  -- post. The nyms table holds one row per identity — the name it goes by NOW — so
  -- adopting a new name reprints every post under it, which is what the claim
  -- flow already promises: "you keep the old name, it just stops being the one
  -- you show". Denormalising would freeze each post under whatever name was
  -- current when it was written, and the board would show one person under
  -- several names.
  LEFT JOIN nyms ny
    ON ny.pubkey = p.pubkey
`;

/**
 * The feed shows THREAD ROOTS ONLY. Replies are read inside a thread.
 *
 * ⚠ EVERY FEED READ NEEDS THIS. Miss it on one and replies leak into the feed as
 * though they were top-level posts — out of context, and duplicated under their
 * own thread. Worst on `getNewPosts`, which the client polls every 5 seconds, so
 * one reply would pop into everyone's live feed.
 *
 * Cursor pagination is unaffected: Feed.tsx pages on `id < before` / `id > after`,
 * and filtering rows out cannot break a cursor while the column stays monotonic
 * and unique — which `id` (INTEGER PRIMARY KEY) is. The windows simply span a
 * wider id range.
 */
const ROOTS_ONLY = "p.parent_id IS NULL";

/**
 * Posts written ON OpenBooks, excluding the inherited OpenCook history.
 *
 * ⚠ THE DEFAULT, DELIBERATELY. Posts 1..FORK_POINT_ID happened on OpenCook: other
 * people's words, signed by them, anchored on-chain under `app: "opencook"`.
 * Rendering them inline in this feed presents them as if they were said here,
 * which they were not — the owner's objection, and a fair one. They are still
 * reachable, behind an explicit toggle that labels them for what they are.
 *
 * Keeping them in the database rather than deleting them is the point: the fork
 * is only checkable if the shared history is actually here. This hides them from
 * the default view; it does not disown them.
 */
const OPENBOOK_ONLY = `p.id > ${FORK_POINT_ID}`;

/** The era filter for a feed read. `true` includes the inherited OpenCook run-up. */
function eraClause(includeInherited: boolean): string {
  return includeInherited ? ROOTS_ONLY : `${ROOTS_ONLY} AND ${OPENBOOK_ONLY}`;
}

export async function getPosts(beforeId?: number, includeInherited = false): Promise<Post[]> {
  const where = eraClause(includeInherited);
  if (beforeId !== undefined) {
    return db
      .prepare(`${POST_SELECT} WHERE ${where} AND p.id < ? ORDER BY p.id DESC LIMIT 100`)
      .all(beforeId) as Post[];
  }
  return db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY p.id DESC LIMIT 100`).all() as Post[];
}

export async function getNewPosts(sinceId: number): Promise<Post[]> {
  if (!Number.isInteger(sinceId) || sinceId < 0) return [];
  return db
    .prepare(`${POST_SELECT} WHERE ${ROOTS_ONLY} AND p.id > ? ORDER BY p.id DESC`)
    .all(sinceId) as Post[];
}

/**
 * Every post in a thread, oldest first — the root and its replies at any depth.
 *
 * ONE indexed lookup on `root_id`, not a recursive walk, because the migration
 * denormalises the root onto every row (THREADS.md). This is also the query the
 * token-allocation path would run per mint, which is why the root is stored
 * rather than derived.
 *
 * Deliberately NOT filtered by `parent_id`: a root carries `root_id = id`, so it
 * is included and appears first.
 */
export async function getThread(rootId: number): Promise<Post[]> {
  if (!Number.isInteger(rootId) || rootId <= 0) return [];
  // ⚠ THE SECOND CLAUSE IS THE BRANCH POINTS, AND IT IS NOT OPTIONAL. Claiming a
  // ticker re-roots the claiming post onto its own thread, which by construction
  // removes it from THIS thread's `root_id` set — so without this the post that
  // started a branch simply disappears from the conversation it branched off, and
  // the `$child` link goes with it. The parent thread would show a discussion with
  // a hole where the interesting turn was.
  //
  // It adds only re-rooted direct children: an ordinary reply already carries this
  // root and is matched by the first clause, so nothing is duplicated. Their OWN
  // replies stay in the child thread, which is what keeps the two pages distinct.
  return db
    .prepare(
      `${POST_SELECT}
       WHERE p.root_id = ?
          OR p.parent_id IN (SELECT id FROM posts WHERE root_id = ?)
       ORDER BY p.id ASC LIMIT 500`
    )
    .all(rootId, rootId) as Post[];
}

/**
 * Get posts that have been updated since the client last saw them.
 * Currently this means posts that recently received a tx_id (on-chain confirmation).
 * Returns posts with id <= sinceId that have a tx_id (the client may have them without tx_id).
 */
export async function getUpdatedPosts(knownIds: number[]): Promise<Post[]> {
  if (!knownIds.length) return [];
  // Only check posts the client already has — return those that now have a tx_id
  const placeholders = knownIds.map(() => "?").join(",");
  return db
    .prepare(
      `${POST_SELECT} WHERE p.id IN (${placeholders}) AND p.tx_id IS NOT NULL ORDER BY p.id DESC`
    )
    .all(...knownIds) as Post[];
}

export async function getOlderPosts(beforeId: number, includeInherited = false): Promise<Post[]> {
  if (!Number.isInteger(beforeId) || beforeId <= 0) return [];
  return getPosts(beforeId, includeInherited);
}

/**
 * The oldest 100 posts, ascending — the ORIGIN window.
 *
 * By default this is OpenBooks's OWN genesis (the first post after the fork), not
 * post id 1. Jumping a new reader to the start of somebody else's board and
 * calling it the beginning would misrepresent both projects.
 */
export async function getOldestPosts(includeInherited = false): Promise<Post[]> {
  return db
    .prepare(`${POST_SELECT} WHERE ${eraClause(includeInherited)} ORDER BY p.id ASC LIMIT 100`)
    .all() as Post[];
}

/** Next 100 posts NEWER than afterId, ascending — ORIGIN mode reads forward. */
export async function getForwardPosts(afterId: number, includeInherited = false): Promise<Post[]> {
  if (!Number.isInteger(afterId) || afterId < 0) return [];
  return db
    .prepare(
      `${POST_SELECT} WHERE ${eraClause(includeInherited)} AND p.id > ? ORDER BY p.id ASC LIMIT 100`
    )
    .all(afterId) as Post[];
}

/**
 * Authoritative boot counts for a set of (confirmed, visible) posts. Lets the
 * feed poll refresh counts that change from ANY boot source — Bootboard re-boot,
 * another user, a server-funded free boost — not just this client's optimistic
 * +1. Lightweight: returns only `id` + `boot_count`, no post bodies.
 */
/**
 * Live counts for posts the client already has on screen.
 *
 * ⚠ REPLY COUNTS *NEED* THIS CHANNEL — they cannot ride the normal feed poll.
 * `getNewPosts` filters replies out (they are not roots), and `getUpdatedPosts`
 * only returns posts that just gained a `tx_id`. So when someone replies, NOTHING
 * else re-fetches the root's row, and its "N replies" would sit stale until a
 * full page reload. Same reasoning that made boot counts live in the first place
 * (DECISIONS "Live boot counts") — reply counts are the second instance of it.
 */
export async function getPostCounts(
  ids: number[]
): Promise<{ id: number; boot_count: number; reply_count: number }[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`
    SELECT p.id,
           COALESCE(bc.boot_count, 0) as boot_count,
           COALESCE(rc.reply_count, 0) as reply_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    LEFT JOIN (
      SELECT root_id, COUNT(*) as reply_count FROM posts WHERE parent_id IS NOT NULL GROUP BY root_id
    ) rc
      ON rc.root_id = p.id
    WHERE p.id IN (${placeholders})
  `)
    .all(...ids) as { id: number; boot_count: number; reply_count: number }[];
}

export async function getBootboard(): Promise<BootboardData> {
  const current = db
    .prepare(`
    SELECT b.*, p.content, p.author_name, p.signature,
      pn.symbol AS author_nym, bn.symbol AS boosted_by_nym
    FROM bootboard b
    JOIN posts p ON p.id = b.post_id
    -- The post author joins by pubkey, the SPENDER by address: the two are
    -- recorded differently (a post carries a pubkey, a boost carries an
    -- address). Without the second join one identity reads as its nym when it
    -- writes and as anon_xxxx the moment it spends.
    -- NOTE: no backticks in this comment -- it lives inside a template literal.
    LEFT JOIN nyms pn ON pn.pubkey = p.pubkey
    LEFT JOIN nyms bn ON bn.address = b.boosted_by
    WHERE b.held_until IS NULL
    ORDER BY b.booted_at DESC
    LIMIT 1
  `)
    .get() as BootboardRow | undefined;

  const history = db
    .prepare(`
    SELECT b.post_id, b.boosted_by, b.boosted_by_name, b.booted_at, b.held_until,
      CAST((julianday(b.held_until) - julianday(b.booted_at)) * 86400 AS INTEGER) as duration_seconds,
      p.content, p.author_name,
      pn.symbol AS author_nym, bn.symbol AS boosted_by_nym
    FROM bootboard b
    JOIN posts p ON p.id = b.post_id
    LEFT JOIN nyms pn ON pn.pubkey = p.pubkey
    LEFT JOIN nyms bn ON bn.address = b.boosted_by
    WHERE b.held_until IS NOT NULL
    ORDER BY b.held_until DESC
    LIMIT 50
  `)
    .all() as BootboardHistoryRow[];

  const stats = db
    .prepare(`
    SELECT COUNT(*) as total_boots FROM bootboard
  `)
    .get() as { total_boots: number };

  return { current: current ?? null, history, totalBoots: stats.total_boots };
}

export interface BootPostResult {
  processingMs: number;
  // Present on success
  success?: boolean;
  isFree?: boolean;
  txid?: string;
  recipients?: number;
  // Present when the client must handle payment
  requiresPayment?: boolean;
  bootPrice?: number;
  // Present on failure
  error?: string;
  // Free-boot broadcast timed out — the boot MAY have landed. The client must
  // treat this as "submitted" and NOT offer a retry (a retry double-pays). No
  // `error` is set so the client doesn't show a failure/retry. Phase 2 Build A.
  indeterminate?: boolean;
}

export async function bootPost(
  postId: number,
  boostedBy: string,
  boostedByName: string
): Promise<BootPostResult> {
  const start = performance.now();

  // Input validation
  if (!Number.isInteger(postId) || postId <= 0) return { processingMs: 0, error: "Invalid postId" };
  if (typeof boostedBy !== "string" || boostedBy.length > 200 || boostedBy.trim().length === 0)
    return { processingMs: 0, error: "Invalid boostedBy" };
  if (typeof boostedByName !== "string" || boostedByName.trim().length === 0)
    return { processingMs: 0, error: "Invalid boostedByName" };

  // 30 boots per minute per caller.
  const rl = rateLimit(`bootPost:${boostedBy}`, { limit: 30, windowMs: 60_000 });
  if (!rl.success) return { processingMs: 0, error: "Rate limit exceeded" };

  // Check whether the per-identity grant would make this boot free (server pays)
  // or paid (client must build tx).
  const { isFree: grantAllowsFree, price: bootPrice } = getBootPriceForUser(db, boostedBy);

  // Per-IP cap on SERVER-FUNDED free boots — additive defense that STACKS WITH
  // the per-identity grant (whichever binds first wins). Only consult/consume
  // the IP bucket when the grant would otherwise make this free: paid boots cost
  // the server nothing, so they must NEVER be gated by the IP cap (a paying user
  // can't be blocked). Fails toward PAID. See DECISIONS.md "Per-IP free-boot cap".
  let isFree = grantAllowsFree;
  let effectiveBootPrice = bootPrice;
  if (grantAllowsFree) {
    if (!hasDailyBudget(FREE_BOOT_COST_SATS)) {
      // Daily server-spend ceiling reached → route this free boost to paid (the
      // boost still happens, the user funds it), exactly like grant exhaustion.
      isFree = false;
      effectiveBootPrice = getBootPrice(db);
    } else {
      const hdrs = await headers();
      const ip =
        hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        hdrs.get("x-real-ip")?.trim() ||
        "unknown";
      if (!tryConsumeFreeBootForIp(ip)) {
        // IP cap binds → route to paid, exactly like grant exhaustion. The grant
        // path returns price 0, so recompute the real dynamic price for the client.
        isFree = false;
        effectiveBootPrice = getBootPrice(db);
      }
    }
  }

  if (!isFree) {
    // Paid boot: client must build and broadcast the split transaction itself,
    // then call /api/boot-confirm. Return the price so the client can proceed.
    const processingMs = Math.round((performance.now() - start) * 100) / 100;
    return { processingMs, requiresPayment: true, bootPrice: effectiveBootPrice, isFree: false };
  }

  // Free boot: server wallet pays, orchestrator handles the full workflow.
  const result = await executeBoot(db, postId, boostedBy, boostedByName);

  const processingMs = Math.round((performance.now() - start) * 100) / 100;

  if (!result.success) {
    // Broadcast timed out — the free boot MAY have landed on-chain. Signal the
    // client it's "submitted" (NO error → no "tap to retry", which would rebuild
    // a new tx and double-pay this post). The grant is already consumed; the feed
    // poll surfaces the boot if it landed. See Phase 2 Build A.
    if (result.indeterminate) {
      // Broadcast timed out — the server wallet MAY have spent (the tx may have
      // landed; the grant is consumed, not refunded). Count it against the daily
      // ceiling — over-counting a non-landed tx is the safe direction for a cap.
      recordDailySpend(FREE_BOOT_COST_SATS);
      return { processingMs, indeterminate: true, isFree: true };
    }
    // Step 8: the free grant was exhausted concurrently (another in-flight boot
    // consumed the last slot between the check above and executeBoot's atomic
    // consume) — executeBoot signals this with isFree:false. Route to the paid
    // path so the client transparently builds a paid boot instead of erroring.
    if (!result.isFree) {
      return { processingMs, requiresPayment: true, bootPrice: result.price, isFree: false };
    }
    return { processingMs, error: result.error ?? "Boot failed", isFree: true };
  }

  // Server wallet spent on this free boost — count it against the daily ceiling.
  recordDailySpend(FREE_BOOT_COST_SATS);

  return {
    processingMs,
    success: true,
    isFree: true,
    txid: result.txid,
    recipients: result.recipients,
  };
}
