"use server";

import { headers } from "next/headers";
import { parseBuyCommand } from "@/lib/buy-command";
import { screenContent } from "@/lib/content-filter";
import { db } from "@/lib/db";
import { verifyFillPayment } from "@/lib/fill-payment";
import { FORK_POINT_ID } from "@/lib/fork-point";
import { tryConsumeFreeBootForIp } from "@/lib/free-boot-cap";
import {
  burnUnits,
  creditUnits,
  mintedBySymbol,
  mintedUnits,
  totalUnits,
  transferUnits,
  unitsHeld,
} from "@/lib/holdings";
import {
  attachPreviewToPost,
  firstLinkIn,
  hasPreview,
  savePreview,
  urlHash,
} from "@/lib/link-preview-store";
import { cancelListingMessage, fillMessage, listMessage } from "@/lib/listing-message";
import {
  cheapestAsks,
  findOpenListing,
  MAX_LISTING_UNITS,
  openListings,
  unitsCommitted,
  unitsListable,
} from "@/lib/market";
import { mintChargeSats, mintFloorSats } from "@/lib/mint-charge";
import { mintPriceSats } from "@/lib/mint-price";
import { verifyPaidPost } from "@/lib/paid-post";
import {
  configuredMarkupPercent,
  isPaidPostingEnabled,
  minimumPlatformSats,
} from "@/lib/post-economics";
import { MAX_POST_CHARS } from "@/lib/post-length";
import { rateLimit } from "@/lib/rate-limit";
import { admitFounder, enterRoom, mayEnter, type RoomAccess, roomAccess } from "@/lib/room-access";
import { enterRoomMessage } from "@/lib/room-entry-message";
import {
  FREE_BOOT_COST_SATS,
  hasDailyBudget,
  POST_LOG_COST_SATS,
  recordDailySpend,
} from "@/lib/server-spend-budget";
import {
  canonicalTicker,
  distinctTickers,
  isRootTicker,
  isValidTicker,
  ROOT_TICKER,
} from "@/lib/ticker";
import { getTickerMeaning } from "@/lib/ticker-meaning";
import { tickerTransferAnnouncement, validateTransfer } from "@/lib/ticker-transfer";
import { parseStoredName } from "@/lib/upload";
import { generateAnonName } from "@/lib/utils";

async function getBsvSdk() {
  const { PublicKey, Signature } = await import("@bsv/sdk");
  return { PublicKey, Signature };
}

import { sweepOrphans } from "@/services/bsv/anchor-sweep";
import { logPostOnChain, logRoomEntryOnChain } from "@/services/bsv/onchain";
import { getServerAddress, isServerSpendDisabled } from "@/services/bsv/wallet";
import { executeBoot } from "@/services/fairness/boot-orchestrator";
import { getBootPrice, getBootPriceForUser } from "@/services/fairness/pricing";
import { unfurl } from "@/services/link-unfurl";
import type {
  BootboardData,
  BootboardHistoryRow,
  BootboardRow,
  Post,
  PostPreviewUpdate,
} from "@/types";

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
    | "room_ticket_required"
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
  // Not a length limit — see `post-length.ts`. Paid posting prices length;
  // this only stops a script writing a novel into every feed poll.
  if (content.length > MAX_POST_CHARS) return { ok: false, reason: "bad_input" };

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

    /**
     * ⚠ A NAMED THREAD IS A ROOM, AND SPEAKING IN IT COSTS A TICKET.
     *
     * This is the enforcement that actually holds, and it holds because
     * `pubkey` HAS ALREADY BEEN VERIFIED against the signature above — so the
     * key we check for a ticket is one the author has proved they control. The
     * reading side of the gate is a product boundary rather than a
     * cryptographic one, for the reasons set out in `room-access.ts`; this side
     * is not.
     *
     * Checked BEFORE the post exists, so naming the room's own ticker in the
     * reply cannot buy you in on the way through the door. A ticket is bought
     * with `/buy`, which is a root post and therefore never blocked by this.
     *
     * The board's own thread is not a room — `roomTickerFor` refuses to gate
     * the root — so the main feed is unaffected.
     */
    if (!mayEnter(rootId, pubkey)) return { ok: false, reason: "room_ticket_required" };
  }

  /**
   * An ADDENDUM — a correction appended to a post, because a post cannot be
   * edited (it is anchored on-chain, and rewriting the row would make the site
   * contradict the ledger the post links to).
   *
   * ⚠ ONLY THE ORIGINAL AUTHOR MAY APPEND, AND THE FLAG IS NOT TRUSTED. The
   * client sends `addendum=1`; the parent's author is looked UP and compared to
   * the VERIFIED signer. Without that check anyone could staple a "correction"
   * onto someone else's post and it would render as though that person had
   * written it — which is worse than an edit, because it is an edit attributed
   * to a third party.
   *
   * An addendum is otherwise an ordinary reply, so it inherits signing, content
   * screening, paid posting and on-chain anchoring with no second pipeline.
   */
  let isAddendum = false;
  if (formData.get("addendum") === "1") {
    if (parentId === null) return { ok: false, reason: "invalid_parent" };
    const parent = db.prepare("SELECT pubkey FROM posts WHERE id = ?").get(parentId) as
      | { pubkey: string | null }
      | undefined;
    // An unsigned parent has no author to be, so it can never be added to.
    // `pubkey` here is the VERIFIED signer — the signature check above ran first.
    if (!parent?.pubkey || parent.pubkey !== pubkey) {
      return { ok: false, reason: "invalid_parent" };
    }
    isAddendum = true;
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
      /** A correction appended by the post's own author — see the guard above. */
      addendum: boolean;
    }): number => {
      const res = db
        .prepare(
          "INSERT INTO posts (content, author_name, signature, pubkey, parent_id, root_id, tx_id, vout, is_addendum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          args.content,
          args.author,
          args.sig,
          args.pk,
          args.parent,
          args.root,
          args.txId,
          args.vout,
          args.addendum ? 1 : 0
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
      // ⚠ A FLOOR, NOT THE QUOTED PRICE, AND DERIVED FROM THE SAME CONFIG THE
      // CLIENT WAS QUOTED FROM. The author has ALREADY broadcast and already
      // paid by the time we see this — rejecting for a few satoshis of drift, or
      // for a markup the client was never told to include, takes their money and
      // gives them no post.
      //
      // ⚠ THE MINT CHARGE IS PART OF THE SAME FLOOR because it rides in the same
      // output (see `PostPrice.platformOutputSats`). It is priced BEFORE the
      // insert below, so this post's own mentions are not yet counted — which is
      // exactly the supply the client was quoted from — and it is allowed a
      // tolerance band for the units other people minted in between. A stricter
      // check here would refuse a post whose author did nothing wrong except
      // type slowly. See `mint-charge.ts`.
      minPlatformSats: minimumPlatformSats() + mintFloorSats(content.trim()),
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
    addendum: isAddendum,
  });

  /**
   * Remember which address this pubkey owns.
   *
   * ⚠ SO A LOCKED WALLET CAN STILL BE RECOGNISED. A protected identity keeps its
   * address in the clear and its key encrypted, and locked is the default state
   * — so without this map, every locked holder looks like a stranger at a room
   * they own. Best-effort and never throws into the post path: the post is the
   * durable fact, this is a convenience index. See `identity_addresses`.
   */
  void rememberAddressFor(pubkey);

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

  // ⚠ THIRD, AND THE ORDER IS THE WHOLE REASON IT IS A SEPARATE STEP. Founding a
  // room has to admit its founder, and admission BURNS a unit — which only exists
  // after `recordTickerMentions` has credited it. Doing this inside
  // `registerTickers` (where the claim happens) burned nothing, silently, because
  // the ticket had not been minted yet.
  admitFounders(postId, pubkey);

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
/**
 * Admit the founder to every room this post created.
 *
 * ⚠ WITHOUT THIS, NOBODY CAN SPEAK IN A ROOM THEY JUST FOUNDED. Entry burns a
 * ticket and a claim mints one, so the claimant ends up holding a ticket, having
 * never entered, locked out of their own room. Not hypothetical: it broke six
 * ordinary "start a thread, then reply in it" tests the moment the gate moved from
 * balance to membership.
 *
 * ⚠ AND IT DOES NOT BURN THE FOUNDING UNIT — see `admitFounder` in
 * `room-access.ts` for why that was built, reverted, and why the exception does
 * not reopen the hole burning exists to close.
 *
 * ⚠ CLAIMS ONLY, NEVER MENTIONS. `tickers.post_id = ?` is true only of a claim
 * that LANDED, which is the distinction that matters: merely mentioning an
 * existing ticker also mints a unit, and admitting on that would hand out
 * membership of an expensive room to anybody who typed its name in passing.
 *
 * Best-effort — a post that publishes must not fail because a door did not open.
 */
function admitFounders(postId: number, pubkey: FormDataEntryValue | null): void {
  const pk = typeof pubkey === "string" ? pubkey : null;
  if (!pk) return;
  try {
    const claimed = db
      .prepare("SELECT symbol FROM tickers WHERE post_id = ? AND pubkey = ?")
      .all(postId, pk) as Array<{ symbol: string }>;
    for (const { symbol } of claimed) {
      // The board's own thread is not a room, so there is no door to pass.
      if (isRootTicker(symbol)) continue;
      admitFounder(symbol, pk, mintPriceSats(mintedUnits(symbol)));
    }
  } catch (e) {
    console.error(`OpenBook: founder admission failed for post ${postId}`, e);
  }
}

function recordTickerMentions(
  postId: number,
  content: string,
  pubkey: FormDataEntryValue | null
): void {
  try {
    const pk = typeof pubkey === "string" ? pubkey : null;
    /**
     * ⚠ PRICED BEFORE THE ROWS EXIST, which is the only moment it is correct.
     * `mintChargeSats` reads current supply, and the inserts below ADD to that
     * supply — so computing it afterwards would price the units one notch above
     * what the author was actually quoted and charged.
     *
     * This is the same number `payForPost` funded, from the same function, so a
     * holder's cost basis is what they really paid rather than a reconstruction.
     */
    const chargedSats = mintChargeSats(content);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ticker_mentions
         (symbol, post_id, pubkey, target_type, units, paid_sats)
       VALUES (?, ?, ?, 'none', ?, ?)`
    );

    /**
     * ⚠ A BUY MINTS WHAT IT PAID FOR, AND IS CHECKED FIRST.
     *
     * `/buy 1000 $Memeplex` names a ticker, so the ordinary path below would
     * mint exactly one unit of it — while `mintChargeSats` had already billed
     * the buyer for a thousand. The two derive the buy from the SAME string
     * through the SAME parser precisely so they cannot disagree about what was
     * bought; deriving it twice by different rules is how a charge and a
     * delivery come apart.
     *
     * One row, `units` many. See the column's note in `db.ts` for why it is not
     * a thousand rows.
     */
    const buy = parseBuyCommand(content);
    if (buy) {
      /**
       * ⚠ TWO WRITES, ONE TRANSACTION, AND THEY MEAN DIFFERENT THINGS. The
       * mention is history — this post named this word and minted N units of it,
       * permanently. The holding is ownership, which moves the first time
       * somebody sells. Writing only one of them either loses the record of who
       * said what or loses who owns what; writing them apart leaves a window
       * where a unit exists and belongs to nobody. See `holdings.ts`.
       */
      db.transaction(() => {
        insert.run(buy.symbol, postId, pk, buy.units, chargedSats);
        creditUnits(buy.symbol, pk, buy.units);
      })();
      return;
    }

    const symbols = distinctTickers(content);
    if (!symbols.length) return;
    const all = db.transaction(() => {
      // Per-word share of the post's charge: `mintChargeSats` is the SUM over
      // the words named, so a post naming three splits three ways rather than
      // recording the whole bill against each.
      const each = symbols.length > 0 ? Math.round(chargedSats / symbols.length) : 0;
      for (const symbol of symbols) {
        insert.run(symbol, postId, pk, 1, each);
        creditUnits(symbol, pk, 1);
      }
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
    // ⚠ NULL, not the root. A claim made on the open feed is TOP-LEVEL: nothing
    // enclosed it, and parenting it to `$OpenBooks` asserted a lineage true of
    // every top-level token, which therefore said nothing about any of them. See
    // the reversal note in `repairTickerParents` — that pass recomputes parents
    // on every boot, so this default and its fallback must agree or the boot
    // will simply undo what is written here.
    const parent = enclosing?.symbol ?? null;

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
 *
 * ⚠ READS `ticker_mentions`, THE SAME EDGE TABLE AS `getTickerSupply`. It used to
 * run `UPPER(content) LIKE '%$SYM%'`, which has NO WORD BOUNDARY however much the
 * comment beside it claimed one: `$TICKER` matched the post naming `$Tickeragents`
 * and the compose box announced `$Ticker · 50% · unclaimed`, while the feed —
 * reading the edge table — rendered the same name at 100%. Two counts of "who
 * says this word", one of them a substring search, disagreeing on screen at the
 * same moment.
 *
 * The edge rows are written by `distinctTickers`, the one consensus-critical
 * parse rule, so this now agrees with what gets rendered, what gets CLAIMED, and
 * what supply reports — by construction rather than by two patterns being kept
 * in step. It also drops a full-table scan per symbol for one indexed lookup.
 */
export async function getTickerUsage(symbols: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(symbols.map(canonicalTicker).filter(isValidTicker))].slice(0, 200);
  if (!wanted.length) return {};

  // Every requested symbol answers, so a name nobody has used reads 0 rather
  // than absent — the caller is a hint that must render either way.
  const out: Record<string, number> = Object.fromEntries(wanted.map((s) => [s, 0]));
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      // COALESCE because `root_id` is nullable (ADD COLUMN cannot backfill) and
      // COUNT(DISTINCT …) drops NULLs silently — a thread rooted before the
      // threading migration would otherwise not be counted at all.
      `SELECT m.symbol AS symbol, COUNT(DISTINCT COALESCE(p.root_id, p.id)) AS n
         FROM ticker_mentions m
         JOIN posts p ON p.id = m.post_id
        WHERE m.symbol IN (${placeholders})
        GROUP BY m.symbol`
    )
    .all(...wanted) as { symbol: string; n: number }[];
  for (const r of rows) out[r.symbol] = r.n;
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
  //
  // ⚠ COMPARE THE OWNER, NOT MERE EXISTENCE. This used to reject any symbol that
  // had a row at all, which quietly made a whole class of names unclaimable by
  // the very people entitled to them: `registerTickers` founds a ticker for
  // whoever MENTIONS it first, so anyone who wrote about a name before deciding
  // to adopt it had already locked themselves out of it. The same bug made
  // `transferTicker` pointless — the recipient would own the name and still be
  // unable to go by it.
  const existing = db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(symbol) as
    | { pubkey: string | null }
    | undefined;
  if (existing && existing.pubkey !== pubkey) return { ok: false, reason: "taken" };

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

/**
 * Whether an identity may adopt a symbol as its `$Nym`.
 *
 * ⚠ "EXISTS" IS NOT "UNAVAILABLE", AND CONFLATING THEM BLOCKS THE RIGHTFUL
 * OWNER. Every post registers the tickers it mentions to its author, so people
 * routinely own names they have not adopted — and a recipient of a transfer owns
 * one by definition. The claim modal used to derive availability from
 * `resolveTickers`, which only answers "is there a row", so it told the holder of
 * a name that their own name was taken and disabled the button. The server had
 * already been fixed to compare the owner; this is the same fix on the other
 * side of the wire, and the two must agree or the UI refuses claims the server
 * would accept.
 */
export type NymAvailability = "free" | "yours" | "taken";

export async function checkNymAvailability(
  symbol: string,
  pubkey: string
): Promise<NymAvailability> {
  const canonical = canonicalTicker(String(symbol).trim().replace(/^\$+/, ""));
  if (!isValidTicker(canonical)) return "taken";
  const row = db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(canonical) as
    | { pubkey: string | null }
    | undefined;
  if (!row) return "free";
  return row.pubkey && pubkey && row.pubkey === pubkey ? "yours" : "taken";
}

export type TransferResult =
  | { ok: true; symbol: string }
  | {
      ok: false;
      reason: "invalid" | "invalid_recipient" | "same_owner" | "not_owner" | "post_failed";
    };

/**
 * Hand a `$Ticker` to another identity.
 *
 * Exists because `registerTickers` registers every mentioned symbol to the
 * POSTER, so simply writing about an unclaimed name founds it — and with
 * `symbol` as a PRIMARY KEY there is otherwise no way to undo that, ever.
 *
 * A transfer is a POST, exactly as a claim is: signed by the current owner, paid
 * for, and inscribed. On a board whose proposition is a permanent public record,
 * a change of ownership belongs in that record and not only in a table row.
 *
 * ⚠ THE CONTENT IS CHECKED TO *BE* THE ANNOUNCEMENT, AND THIS IS THE WHOLE
 * SECURITY OF IT. `createPost` verifies the author's signature over the post
 * CONTENT — it knows nothing about the `symbol` and `to_pubkey` form fields, and
 * those fields are not signed. Without the equality check below, an attacker
 * could take any validly signed post of the owner's and submit it here with
 * whatever symbol and recipient they liked, and the signature would still verify.
 * Rebuilding the expected sentence and demanding an exact match is what binds
 * the signature to *this* symbol and *this* recipient.
 */
export async function transferTicker(formData: FormData): Promise<TransferResult> {
  const rawSymbol = formData.get("symbol");
  const rawTo = formData.get("to_pubkey");
  const fromPubkey = formData.get("pubkey");
  const content = formData.get("content");
  if (
    typeof rawSymbol !== "string" ||
    typeof rawTo !== "string" ||
    typeof fromPubkey !== "string" ||
    !fromPubkey ||
    typeof content !== "string"
  ) {
    return { ok: false, reason: "invalid" };
  }

  const symbol = canonicalTicker(rawSymbol.trim().replace(/^\$+/, ""));
  const toPubkey = rawTo.trim().toLowerCase();

  const checked = validateTransfer(symbol, toPubkey, fromPubkey);
  if (!checked.ok) {
    return {
      ok: false,
      reason: checked.reason === "invalid_symbol" ? "invalid" : checked.reason,
    };
  }

  // See the ⚠ above. This is what makes the signature mean anything.
  if (content !== tickerTransferAnnouncement(symbol, toPubkey)) {
    return { ok: false, reason: "invalid" };
  }

  // Ownership is checked BEFORE the post is paid for, so the common refusal —
  // trying to give away a name you do not hold — costs nothing.
  const owner = db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(symbol) as
    | { pubkey: string | null }
    | undefined;
  if (!owner || owner.pubkey !== fromPubkey) return { ok: false, reason: "not_owner" };

  const result = await createPost(formData);
  if (!result.ok) return { ok: false, reason: "post_failed" };

  // Re-read ownership inside the transaction: the check above happened before a
  // network round trip, and the name could have moved in between.
  let moved = false;
  db.transaction(() => {
    const current = db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(symbol) as
      | { pubkey: string | null }
      | undefined;
    if (!current || current.pubkey !== fromPubkey) return;
    db.prepare("UPDATE tickers SET pubkey = ? WHERE symbol = ?").run(toPubkey, symbol);
    // The old holder cannot keep displaying a name they no longer own. The
    // RECIPIENT is deliberately not given the nym here: owning a ticker and
    // going by it are separate acts, and `claimNym` — which checks ownership,
    // and will now pass for them — is where the second one happens.
    db.prepare("DELETE FROM nyms WHERE symbol = ?").run(symbol);
    moved = true;
  })();

  // The announcement is already inscribed either way. It is advisory: the
  // ticker table is what ownership is read from, so say plainly that it did not
  // move rather than reporting a success the database does not agree with.
  if (!moved) return { ok: false, reason: "not_owner" };
  return { ok: true, symbol };
}

/**
 * The `$Ticker`s this identity OWNS — which is not the same as the tickers it
 * holds units of.
 *
 * `getHoldings` answers "what share of the mentions of a name are mine", which
 * is what the wallet shows. Ownership is a different fact: the single pubkey in
 * `tickers.pubkey`, set by whoever mentioned the name FIRST, and the only thing
 * that decides who may adopt it as a nym or hand it on. An identity routinely
 * holds units of names it does not own — citing `$B0ase` once earns a share of
 * it without earning any say over it.
 */
export async function getOwnedTickers(pubkey: string): Promise<string[]> {
  if (!pubkey || typeof pubkey !== "string") return [];
  const rows = db
    .prepare("SELECT symbol FROM tickers WHERE pubkey = ? ORDER BY created_at ASC, symbol ASC")
    .all(pubkey) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

/**
 * What a `$Ticker` currently means, as its agent has read it from usage.
 *
 * Null until the corpus is thick enough to say anything — an honest absence
 * beats a confident definition drawn from two posts.
 */
export async function getTickerMeaningFor(symbol: string): Promise<{
  /** What the board has made it mean. Null until the corpus can support one. */
  meaning: string | null;
  /** What it means in the world — the prior the board accretes on top of. */
  anchor: string | null;
  anchorUrl: string | null;
  corpusSize: number;
  updatedAt: string;
} | null> {
  const m = getTickerMeaning(symbol);
  if (!m) return null;
  return {
    meaning: m.meaning ?? null,
    anchor: m.anchor ?? null,
    anchorUrl: m.anchorUrl ?? null,
    corpusSize: m.corpusSize,
    updatedAt: m.updatedAt,
  };
}

/**
 * Everything an identity has posted, newest first — a PROFILE.
 *
 * ⚠ A NAME'S THREAD IS NOT ITS AUTHOR'S POSTS, and conflating them is why an
 * agent looked mute. `/$occam` opens the thread NAMED $Occam — the post where
 * that ticker was first written — while everything $Occam actually SAYS is a
 * reply living in other people's threads. Somebody clicking a name wants the
 * speaker, not the etymology.
 *
 * Includes replies deliberately: an agent answers questions, so excluding
 * replies would hide almost everything it has ever said.
 */
export async function getPostsByNym(symbol: string): Promise<Post[]> {
  const canonical = canonicalTicker(String(symbol).trim().replace(/^\$+/, ""));
  if (!isValidTicker(canonical)) return [];
  return db
    .prepare(
      `${POST_SELECT}
       WHERE p.pubkey = (SELECT pubkey FROM nyms WHERE symbol = ?)
       ORDER BY p.id DESC LIMIT 50`
    )
    .all(canonical) as Post[];
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

/**
 * Original filenames for uploads currently on screen.
 *
 * ⚠ WHY THE NAME IS NOT IN THE POST. Stored names are content hashes, so a post
 * carries `/m/<64 hex>.pdf` and nothing a reader can recognise — an attachment
 * rendered as "PDF document" tells you only what you could already see from the
 * icon. The real name lives in `uploads.original_name`, recorded at upload time.
 *
 * One call for every attachment on screen, for the same reason `getTickerSupply`
 * takes a list rather than a symbol: a lookup per post would turn scrolling into
 * a query storm.
 *
 * Keyed by STORED NAME (`<hash>.<ext>`), which is what the renderer can derive
 * from a URL without knowing anything else. Missing rows are simply absent —
 * uploads made before provenance existed have no name, and the card falls back
 * to its generic label rather than showing a hash.
 */
/**
 * Threads this identity is part of — the "Threads" tab.
 *
 * ⚠ NOT "MY POSTS". A thread you are in is one you STARTED and somebody answered,
 * or one you REPLIED IN, whoever began it. Listing only your own roots would hide
 * every conversation you joined, which is most of them once agents are answering;
 * listing every post you ever made would just be the feed with a filter.
 *
 * Ordered by the thread's most recent activity rather than by when it started, so
 * a conversation that came back to life returns to the top. That is the ordering
 * every messaging surface uses, and the reason it is right here is the same: the
 * question this tab answers is "what has moved", not "what did I write once".
 *
 * Roots only — the row shows the thread, and `latest_reply_*` already rides
 * `POST_SELECT`, so the preview costs no extra query.
 */
export async function getMyThreads(pubkey: string, limit = 50): Promise<Post[]> {
  if (!pubkey) return [];
  const capped = Math.min(Math.max(1, limit), 100);
  return db
    .prepare(
      `${POST_SELECT}
       WHERE p.parent_id IS NULL
         AND p.id IN (
           -- threads I started that somebody answered, and threads I replied in
           SELECT COALESCE(root_id, id) FROM posts WHERE pubkey = ?
         )
       ORDER BY COALESCE(
         (SELECT MAX(r.id) FROM posts r WHERE r.root_id = p.id AND r.parent_id IS NOT NULL),
         p.id
       ) DESC
       LIMIT ?`
    )
    .all(pubkey, capped) as Post[];
}

export async function getAttachmentNames(names: string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(names)].filter((n) => parseStoredName(n) !== null).slice(0, 200);
  if (!wanted.length) return {};

  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT name, original_name FROM uploads
        WHERE name IN (${placeholders}) AND original_name IS NOT NULL`
    )
    .all(...wanted) as Array<{ name: string; original_name: string }>;

  const out: Record<string, string> = {};
  for (const r of rows) out[r.name] = r.original_name;
  return out;
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
      /**
       * ⚠ ISSUED SUPPLY, NOT THE FLOAT — mentions, not holdings.
       *
       * This briefly read `ticker_holdings` on the reasoning that "supply is what
       * exists", which was indistinguishable from issued supply while the only
       * operation was a transfer. Burning a ticket to enter a room separates them,
       * and it separates them in a way that would have made this number lie about
       * the most successful tokens: every member of a busy room has burned their
       * ticket, so a held-supply count of a hundred-member room reports whatever
       * happens to be left unspent — a popular token would rank BELOW an ignored
       * one. "How big is this token" is how many units were ever issued.
       *
       * The float (units currently held, i.e. what could actually be bought) is a
       * real and different number: `unitsBySymbol` in `holdings.ts`.
       */
      `SELECT symbol, COALESCE(SUM(units), 0) AS n
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
  return {
    paid,
    platformAddress: paid ? getServerAddress() : null,
    // ⚠ THE SAME RESOLVER THE SERVER USES. A second copy here previously read a
    // blank env var as 0% (`Number("") === 0`), so the client built no platform
    // output and the server rejected the post for underpayment — after the
    // author had already paid for the broadcast.
    markupPercent: configuredMarkupPercent(),
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
/** A board for a name with no units yet — see the root exception below. */
function emptyBoard(symbol: string): TickerLeaderboard {
  return { symbol, path: [symbol], total: 0, attributed: 0, holders: [] };
}

export interface TickerBoardSummary {
  symbol: string;
  /** Ancestry, root-first — the same path a thread header renders. */
  path: string[];
  /** Units in circulation. */
  total: number;
  /** Distinct owners. Lower than `total` whenever somebody holds more than one. */
  holders: number;
  /**
   * Cheapest second-hand unit on offer, or null when nobody is selling.
   *
   * Beside the mint price this is the whole market in two numbers: the mint
   * price is what a new unit costs, this is what an existing one costs, and the
   * second is normally the lower of the two.
   */
  ask: number | null;
}

/**
 * Every token that HAS a board, heaviest first — the index behind `/leaderboard`.
 *
 * ⚠ DRIVEN BY MENTIONS, NOT BY THE `tickers` TABLE. A board exists wherever
 * units do: `/leaderboard/$name` renders for any name with a unit, claimed or
 * not. Listing from `tickers` would have produced an index that omits pages it
 * links to and links to pages that 404 — an index disagreeing with the thing it
 * indexes.
 *
 * ⚠ THE ROOT IS PINNED FIRST, and listed even at zero units. It is the board
 * itself rather than one name among many, so ranking it by weight would drop the
 * site's own token somewhere down a list of names taken from it.
 *
 * Distinct from `/tickers`, which indexes NAMES — what has been claimed, and by
 * what post. This indexes OWNERSHIP: how many units exist and how many people
 * hold them.
 */
export async function listTickerBoards(limit = 100): Promise<TickerBoardSummary[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const rows = db
    .prepare(
      /**
       * ⚠ TWO DIFFERENT QUESTIONS, SO TWO DIFFERENT TABLES, JOINED.
       *
       * `total` is ISSUED supply, from the append-only mention history. It was
       * held units, and burning broke that in the direction that matters: every
       * member of a busy room has destroyed their ticket, so a held-unit total
       * reports only what happens to be left unspent — a hundred-member room could
       * total zero and sort below a token nobody ever used. It also broke the
       * invariant the index relies on, that only the root may total zero.
       *
       * `holders` stays the ownership ledger, because it answers a question that
       * really is about holdings: who currently has a ticket they could sell. A
       * member who burned their only one is not one of them, and should not be
       * counted as though a resale could come from them.
       *
       * ⚠ SO `holders` MAY BE 0 WHILE `total` IS LARGE, and that is not a bug —
       * it is a full room with nothing for sale. What it also means is that this
       * board no longer describes MEMBERSHIP at all. "Who is in this room" is now
       * a different roster (`room_entries`) and a worthwhile surface; it is not
       * this one. See DECISIONS.md "Entry BURNS the ticket".
       */
      `SELECT m.symbol AS symbol,
              COALESCE(SUM(m.units), 0) AS total,
              (SELECT COUNT(DISTINCT h.pubkey) FROM ticker_holdings h
                WHERE h.symbol = m.symbol AND h.pubkey <> '' AND h.units > 0) AS holders
         FROM ticker_mentions m
        GROUP BY m.symbol
        ORDER BY total DESC, m.symbol ASC
        LIMIT ?`
    )
    .all(capped) as { symbol: string; total: number; holders: number }[];

  const parentStmt = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?");
  const cache = new Map<string, string[]>();
  const pathFor = (symbol: string): string[] => {
    const hit = cache.get(symbol);
    if (hit) return hit;
    const path: string[] = [symbol];
    const seen = new Set([symbol]);
    let cur = symbol;
    // Depth-capped and cycle-guarded for the same reason `getTickerPath` is:
    // this runs on a render path, and "impossible" data is what hangs a request.
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

  // One query for every ask on the page, rather than one per row.
  const asks = cheapestAsks(rows.map((r) => r.symbol));

  const boards = rows
    .filter((r) => !isRootTicker(r.symbol))
    .map((r) => ({
      symbol: r.symbol,
      path: pathFor(r.symbol),
      total: r.total,
      holders: r.holders,
      ask: asks.get(r.symbol) ?? null,
    }));

  const rootRow = rows.find((r) => isRootTicker(r.symbol));
  return [
    {
      symbol: ROOT_TICKER,
      path: [ROOT_TICKER],
      total: rootRow?.total ?? 0,
      holders: rootRow?.holders ?? 0,
      ask: asks.get(ROOT_TICKER) ?? null,
    },
    ...boards,
  ];
}

export async function getTickerLeaderboard(
  symbol: string,
  limit = 100
): Promise<TickerLeaderboard | null> {
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return null;

  const totals = db
    .prepare(
      // Both figures are UNITS — the page prints them as a supply and an
      // owned share, and the unowned remainder is their difference.
      // ⚠ COALESCE, BECAUSE THIS AGGREGATE IS NOT GROUPED. `SUM()` over no rows
      // is NULL where `COUNT(*)` was 0 — so the "nobody has written this name"
      // check below silently stopped firing and every unwritten name rendered
      // an empty leaderboard instead of 404ing.
      `SELECT COALESCE(SUM(units), 0) AS total,
              COALESCE(SUM(CASE WHEN pubkey <> '' THEN units ELSE 0 END), 0) AS attributed
         FROM ticker_holdings WHERE symbol = ?`
    )
    .get(canonical) as { total: number; attributed: number | null };

  /**
   * Does this token EXIST — which is not the same question as whether anybody
   * currently holds one.
   *
   * ⚠ A BURNED-OUT ROOM IS A REAL TOKEN WITH NO HOLDERS, and testing held units
   * for existence made the index link to a 404: a founder whose only unit was
   * burned at their own door left `ticker_holdings` empty, so the board this page
   * is reached from listed a token whose page denied it. Existence is issuance,
   * which is permanent; holdings are a snapshot that burning can legitimately
   * take to zero.
   */
  const issued = mintedUnits(canonical);

  // A name nobody has ever written is not an empty leaderboard, it is not a
  // token — the page 404s rather than implying it exists.
  //
  // ⚠ THE ROOT IS THE EXCEPTION, and it is not a special case so much as the
  // absence of one: `$OpenBooks` is the board itself, so it cannot fail to
  // exist, and it is linked from the header of every page. A 404 there would be
  // the site reporting that it is not a thing. An honest empty board is the
  // right answer while nobody has named it yet.
  if (issued === 0) return isRootTicker(canonical) ? emptyBoard(canonical) : null;
  // Issued but nothing held: everybody spent their ticket at the door. An honest
  // empty holder list, not a 404.
  if (!totals || totals.total === 0) return emptyBoard(canonical);

  // The cap matches the split's 100. A leaderboard that listed more holders than
  // a payment can reach would advertise a share nobody can be paid.
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = db
    .prepare(
      `SELECT h.pubkey AS pubkey, h.units AS units, n.symbol AS nym
         FROM ticker_holdings h
         LEFT JOIN nyms n ON n.pubkey = h.pubkey
        WHERE h.symbol = ? AND h.pubkey <> '' AND h.units > 0
        ORDER BY units DESC, h.pubkey ASC
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
      /**
       * ⚠ `mine` IS HELD, `total` IS ISSUED, and mixing them up breaks the very
       * agreement this query exists to keep. `mine` must be what the holder can
       * actually sell, which burning legitimately reduces. `total` must be the
       * number the FEED prints beside the same ticker — `getTickerSupply`, which
       * counts issued units — or the wallet says "2 of 3" while the feed says
       * "one of 4" about the same token, which is the exact disagreement the
       * comment above describes and this query was rewritten to end.
       */
      `SELECT h.symbol AS symbol,
              SUM(CASE WHEN h.pubkey = ? THEN h.units ELSE 0 END) AS mine,
              (SELECT COALESCE(SUM(m.units), 0) FROM ticker_mentions m
                WHERE m.symbol = h.symbol) AS total,
              t.root_id AS root_id,
              (SELECT p.tx_id FROM posts p WHERE p.id = t.root_id) AS tx_id
         FROM ticker_holdings h
         JOIN tickers t ON t.symbol = h.symbol
        WHERE h.symbol IN (
                SELECT symbol FROM ticker_holdings WHERE pubkey = ? AND units > 0
              )
        GROUP BY h.symbol
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
         ny.symbol      as author_nym,
         -- ⚠ THE LATEST REPLY, INLINE. A reply lives behind a ~20px icon in the
         -- gutter, so an agent answering you was invisible on the one screen you
         -- were watching — the feature looked dead for hours while it worked.
         -- Carried on the SAME select as reply_count so the preview can never
         -- describe a different revision of the thread than the count beside it,
         -- and so surfacing it costs no extra round trip.
         lr.content     as latest_reply_content,
         lr.author_name as latest_reply_author,
         lrn.symbol     as latest_reply_nym
  FROM posts p
  LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
    ON bc.post_id = p.id
  LEFT JOIN (
    -- ⚠ ADDENDA ARE NOT REPLIES. They are the author correcting themselves, so
    -- counting one would show "1 reply" on a post nobody answered.
    SELECT root_id, COUNT(*) as reply_count FROM posts
     WHERE parent_id IS NOT NULL AND COALESCE(is_addendum, 0) = 0 GROUP BY root_id
  ) rc
    ON rc.root_id = p.id
  LEFT JOIN (
    SELECT r.root_id, r.content, r.author_name, r.pubkey
      FROM posts r
      JOIN (SELECT root_id, MAX(id) AS id FROM posts WHERE parent_id IS NOT NULL GROUP BY root_id) m
        ON m.id = r.id
  ) lr
    -- ⚠ NEVER FOR A ROOM. A named thread is gated — one unit of its token is the
    -- ticket in (see room-access.ts) — and this join was printing its newest
    -- message on the PUBLIC FEED, to everybody, holder or not. The door was
    -- working and the timeline was reading the room out loud through the wall.
    --
    -- ⚠ SUPPRESSED IN THE QUERY, NOT IN THE RENDER, and that distinction is the
    -- whole fix. Hiding it in the component would leave the text in the RSC
    -- payload, where anyone can read it — a "gate" made of CSS.
    --
    -- Suppressed for HOLDERS too. The feed is a public surface and cannot know
    -- who is looking; a holder sees the room by opening it. That costs a holder
    -- one tap and costs a non-holder nothing they were entitled to.
    --
    -- The board's own token is not a room, so the main feed keeps its previews.
    ON lr.root_id = p.id
   AND NOT EXISTS (
     SELECT 1 FROM tickers t
      WHERE t.root_id = p.id AND t.symbol <> '${ROOT_TICKER}'
   )
  LEFT JOIN nyms lrn
    ON lrn.pubkey = lr.pubkey
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
/**
 * One post by id, for its permalink.
 *
 * ⚠ A POST NEEDS ITS OWN URL, and until now it had none — the only way to reach
 * one was to find it in a feed. That makes a post unshareable, which is a strange
 * property for a board whose whole claim is that what you wrote is yours and
 * permanent: you owned it and could not link to it.
 *
 * Carries the full `POST_SELECT` shape so a permalink renders identically to the
 * same post in the feed — same boost count, same reply count, same unfurl. A
 * thinner query here would make a shared link look like a different post.
 */
/**
 * Corrections the author appended to a post, oldest first.
 *
 * ⚠ ORDER IS PART OF THE MEANING. An addendum corrects what came before it, so a
 * reader has to see them in the order they were written — reversing them would
 * show the retraction before the claim.
 *
 * Returned separately from replies rather than mixed in: an addendum is the
 * author revising themselves, and a reply is somebody else answering. Rendering
 * them in one list would make a correction look like a conversation.
 */
/**
 * What this post owes for the tokens it mints — the number the author is
 * actually charged.
 *
 * ⚠ TAKES THE CONTENT, NOT A SYMBOL LIST. The server derives the words itself,
 * with the same `distinctTickers` that decides which units get minted, so a
 * client cannot be quoted for one set of words and mint another. See
 * `mint-charge.ts`.
 *
 * Called once, at post time, right before the transaction is built — the
 * shortest window the race allows. What remains of that race is absorbed by the
 * server's tolerance band (`MINT_SLACK_UNITS`) rather than by refusing a post
 * somebody has already paid for.
 */
export async function getMintCharge(content: string): Promise<number> {
  if (typeof content !== "string" || content.trim() === "") return 0;
  return mintChargeSats(content.trim());
}

/**
 * What the words in a draft would cost to mint, right now.
 *
 * ⚠ A QUOTE FOR DISPLAY, capped to a handful of words because it feeds the hint
 * under the compose box. The CHARGE is `getMintCharge`, which prices every word
 * — capping what is billed would mint tokens nobody paid for.
 *
 * Supply moves whenever anyone else names the same word, so a price shown while
 * someone is typing can be stale by the time they broadcast. The server absorbs
 * that with a tolerance band (see `MINT_SLACK_UNITS`); it is never resolved by
 * rejecting a post that has already been paid for.
 */
export async function getMintQuote(
  symbols: string[]
): Promise<{ symbol: string; supply: number; priceSats: number }[]> {
  const wanted = [...new Set(symbols.map(canonicalTicker).filter(isValidTicker))].slice(0, 10);
  if (!wanted.length) return [];

  const placeholders = wanted.map(() => "?").join(",");
  // ⚠ BOTH NUMBERS COME FROM THE MINTED COUNTER, and they have to agree: a
  // "supply" of 40 next to a price struck at 12 would be two different tokens on
  // one row. Issued supply IS the curve's position — see `getTickerSupply` for
  // why held units are the wrong public figure, and `holdings.ts` for the float.
  const minted = mintedBySymbol(wanted);
  return wanted.map((symbol) => {
    const n = minted.get(symbol) ?? 0;
    return { symbol, supply: n, priceSats: mintPriceSats(n) };
  });
}

export async function getAddenda(postId: number): Promise<Post[]> {
  if (!Number.isFinite(postId) || postId <= 0) return [];
  return db
    .prepare(
      `${POST_SELECT} WHERE p.parent_id = ? AND COALESCE(p.is_addendum, 0) = 1 ORDER BY p.id ASC`
    )
    .all(Math.floor(postId)) as Post[];
}

/**
 * Whether this reader may take part in a thread, and what the door costs.
 *
 * ⚠ THE READING GATE IS A PRODUCT BOUNDARY, NOT SECRECY — see `room-access.ts`.
 * The pubkey arrives unsigned, and holdings are public, so this answers "should
 * this reader be shown the room" rather than "can this reader be stopped". What
 * cannot be bypassed is SPEAKING: `createPost` checks the same rule against a
 * signature-verified key.
 */
export async function getRoomAccess(
  rootId: number,
  pubkey: string | null,
  address?: string | null
): Promise<RoomAccess> {
  if (!Number.isInteger(rootId) || rootId <= 0) {
    return { symbol: null, gated: false, entered: false, held: 0, priceSats: 0 };
  }
  return roomAccess(rootId, resolveViewer(pubkey, address));
}

/**
 * Verify an ECDSA signature over a canonical message.
 *
 * ⚠ EVERY MARKET ACTION IS AUTHORISED THIS WAY, because each one moves somebody
 * else's property: listing promises units, cancelling withdraws a promise a
 * buyer may be acting on, and a fill claims a payment. The message names every
 * term it authorises (see `listing-message.ts`), so a captured signature cannot
 * be reused for different terms.
 */
async function signedBy(pubkey: string, signature: string, message: string): Promise<boolean> {
  try {
    const { PublicKey, Signature } = await getBsvSdk();
    return PublicKey.fromString(pubkey).verify(
      Array.from(new TextEncoder().encode(message)),
      Signature.fromDER(signature, "hex")
    );
  } catch {
    return false;
  }
}

export type ListResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: "invalid_signature" | "invalid_terms" | "not_enough_units" | "rate_limited";
    };

/**
 * Offer units for sale.
 *
 * Free, and deliberately: a listing moves nothing until somebody fills it, and
 * charging for the right to offer would thin the book for no gain. What bounds
 * it is that the seller must actually hold what they list — and the check
 * subtracts what they have ALREADY offered, or the same ten units could be sold
 * four times over.
 */
export async function listUnits(formData: FormData): Promise<ListResult> {
  const symbol = canonicalTicker(String(formData.get("symbol") ?? ""));
  const units = Number(formData.get("units"));
  const priceSats = Number(formData.get("price_sats"));
  const pubkey = String(formData.get("pubkey") ?? "");
  const signature = String(formData.get("signature") ?? "");

  if (!isValidTicker(symbol)) return { ok: false, reason: "invalid_terms" };
  if (!Number.isSafeInteger(units) || units < 1 || units > MAX_LISTING_UNITS) {
    return { ok: false, reason: "invalid_terms" };
  }
  if (!Number.isSafeInteger(priceSats) || priceSats < 1) {
    return { ok: false, reason: "invalid_terms" };
  }
  if (!pubkey) return { ok: false, reason: "invalid_signature" };

  const rl = rateLimit(`listUnits:${pubkey}`, { limit: 20, windowMs: 60_000 });
  if (!rl.success) return { ok: false, reason: "rate_limited" };

  if (!(await signedBy(pubkey, signature, listMessage(symbol, units, priceSats)))) {
    return { ok: false, reason: "invalid_signature" };
  }

  // ⚠ THE ADDRESS IS DERIVED FROM THE VERIFIED KEY, NEVER SUPPLIED. A
  // client-supplied payout address would let somebody list units they hold and
  // have buyers pay a stranger — or, worse, let an attacker list on their own
  // key and collect at an address they do not control, which is a support
  // problem rather than a theft, but still not ours to create.
  let sellerAddress: string;
  try {
    const { PublicKey } = await getBsvSdk();
    sellerAddress = PublicKey.fromString(pubkey).toAddress().toString();
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  if (unitsListable(symbol, pubkey) < units) return { ok: false, reason: "not_enough_units" };

  const res = db
    .prepare(
      `INSERT INTO listings (symbol, seller_pubkey, seller_address, units, price_sats)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(symbol, pubkey, sellerAddress, units, priceSats);
  return { ok: true, id: res.lastInsertRowid as number };
}

/** Withdraw an offer. Only the seller can, and only their own. */
export async function cancelListing(formData: FormData): Promise<{ ok: boolean }> {
  const id = Number(formData.get("listing_id"));
  const pubkey = String(formData.get("pubkey") ?? "");
  const signature = String(formData.get("signature") ?? "");
  if (!Number.isSafeInteger(id) || id <= 0 || !pubkey) return { ok: false };
  if (!(await signedBy(pubkey, signature, cancelListingMessage(id)))) return { ok: false };

  const res = db
    .prepare(
      `UPDATE listings SET cancelled_at = datetime('now')
        WHERE id = ? AND seller_pubkey = ? AND cancelled_at IS NULL`
    )
    .run(id, pubkey);
  return { ok: res.changes > 0 };
}

/**
 * Burn one ticket and enter a room.
 *
 * ⚠ SIGNATURE-VERIFIED, BECAUSE IT DESTROYS SOMEBODY'S PROPERTY. Every other
 * gate in this file that moves units is authorised the same way; this one has to
 * be, because an unauthenticated version would let anybody burn anybody's ticket
 * by naming their pubkey. The message names the room (`room-entry-message.ts`),
 * so a captured signature cannot be replayed against a different, dearer door.
 *
 * ⚠ IDEMPOTENT, AND THAT IS NOT A NICETY. A lost response on a double-tap must
 * not cost a second ticket, so `enterRoom` returns success without burning
 * anything when the key is already a member.
 *
 * ⚠ THE BURN IS ANCHORED, AND THE ANCHOR IS BEST-EFFORT WHILE THE MEMBERSHIP IS
 * NOT. The on-chain record is what makes membership checkable by somebody who
 * does not trust this database — but a chain write that fails must not swallow a
 * ticket that has already been destroyed. So the DB transaction is the
 * authority today and the anchor is fire-and-forget, exactly as post logging is.
 * See DECISIONS.md "Entry BURNS the ticket" on what is and is not verified yet.
 */
export async function enterRoomAction(
  formData: FormData
): Promise<{ ok: true; alreadyMember: boolean } | { ok: false; reason: string }> {
  const symbol = canonicalTicker(String(formData.get("symbol") ?? ""));
  const pubkey = String(formData.get("pubkey") ?? "");
  const signature = String(formData.get("signature") ?? "");
  if (!isValidTicker(symbol) || !pubkey) return { ok: false, reason: "invalid" };
  if (isRootTicker(symbol)) return { ok: false, reason: "not_a_room" };
  if (!(await signedBy(pubkey, signature, enterRoomMessage(symbol)))) {
    return { ok: false, reason: "bad_signature" };
  }

  // Priced BEFORE the burn: the curve reads minted units, which a burn does not
  // move, but taking the number first keeps the recorded cost basis equal to what
  // the door was actually showing.
  const paidSats = mintPriceSats(mintedUnits(symbol));
  const res = enterRoom(symbol, pubkey, { burnTxid: "", paidSats });
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.alreadyMember) return { ok: true, alreadyMember: true };

  // Fire-and-forget, and the txid is written back if it lands. A NULL `burn_txid`
  // therefore means one of two things — grandfathered from hold-to-enter, or an
  // anchor that did not land — and neither invalidates the membership.
  void logRoomEntryOnChain({ symbol, member: pubkey, paidSats })
    .then((txid) => {
      if (!txid) return;
      db.prepare("UPDATE room_entries SET burn_txid = ? WHERE symbol = ? AND pubkey = ?").run(
        txid,
        symbol,
        pubkey
      );
    })
    .catch(() => {});

  return { ok: true, alreadyMember: false };
}

export interface ListingView {
  id: number;
  symbol: string;
  unitsLeft: number;
  priceSats: number;
  /** The seller's public name, when they have one. */
  sellerNym: string | null;
  mine: boolean;
}

/** The ask side of the book for one token, cheapest first. */
export async function getListings(symbol: string, viewer?: string): Promise<ListingView[]> {
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return [];
  const nymOf = db.prepare("SELECT symbol FROM nyms WHERE pubkey = ?");
  return openListings(canonical).map((l) => ({
    id: l.id,
    symbol: l.symbol,
    unitsLeft: l.unitsLeft,
    priceSats: l.priceSats,
    sellerNym: (nymOf.get(l.sellerPubkey) as { symbol: string } | undefined)?.symbol ?? null,
    mine: !!viewer && viewer === l.sellerPubkey,
  }));
}

/** What a buyer must pay, and where — everything needed to build the transaction. */
export async function getFillQuote(
  listingId: number,
  units: number
): Promise<{ ok: true; address: string; totalSats: number } | { ok: false }> {
  const listing = findOpenListing(listingId);
  if (!listing) return { ok: false };
  const n = Math.floor(units);
  if (!Number.isSafeInteger(n) || n < 1 || n > listing.unitsLeft) return { ok: false };
  return { ok: true, address: listing.sellerAddress, totalSats: n * listing.priceSats };
}

export type FillResult =
  | { ok: true; units: number }
  | {
      ok: false;
      reason:
        | "invalid_signature"
        | "gone"
        | "invalid_terms"
        | "underpaid"
        | "replay"
        | "seller_short"
        | "rate_limited";
    };

/**
 * Complete a purchase from the market.
 *
 * The buyer has ALREADY paid the seller, peer to peer, in a transaction this
 * platform never touched. What happens here is the ledger moving to match a
 * payment that has been verified against the bytes — see `market.ts` for why
 * that is a real trust assumption and not a trustless swap.
 *
 * ⚠ EVERY CHECK RUNS BEFORE ANYTHING MOVES, and the move itself is one
 * transaction. A debit without a credit is somebody's property destroyed; a fill
 * recorded without a debit is a unit sold twice.
 */
export async function fillListing(formData: FormData): Promise<FillResult> {
  const listingId = Number(formData.get("listing_id"));
  const units = Number(formData.get("units"));
  const rawTx = String(formData.get("raw_tx") ?? "").trim();
  const pubkey = String(formData.get("pubkey") ?? "");
  const signature = String(formData.get("signature") ?? "");

  if (!Number.isSafeInteger(listingId) || listingId <= 0) return { ok: false, reason: "gone" };
  if (!Number.isSafeInteger(units) || units < 1) return { ok: false, reason: "invalid_terms" };
  if (!pubkey || !rawTx) return { ok: false, reason: "invalid_signature" };

  const rl = rateLimit(`fillListing:${pubkey}`, { limit: 20, windowMs: 60_000 });
  if (!rl.success) return { ok: false, reason: "rate_limited" };

  const listing = findOpenListing(listingId);
  if (!listing) return { ok: false, reason: "gone" };
  if (units > listing.unitsLeft) return { ok: false, reason: "invalid_terms" };
  // Buying from yourself would move nothing and pay yourself; refuse it rather
  // than let it look like a trade that happened.
  if (listing.sellerPubkey === pubkey) return { ok: false, reason: "invalid_terms" };

  const verdict = verifyFillPayment({
    rawTx,
    sellerAddress: listing.sellerAddress,
    minSats: units * listing.priceSats,
  });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason === "malformed_tx" ? "invalid_terms" : "underpaid" };
  }

  if (!(await signedBy(pubkey, signature, fillMessage(listingId, units, verdict.txid)))) {
    return { ok: false, reason: "invalid_signature" };
  }

  // ⚠ THE SELLER MAY NO LONGER HAVE THEM. Holdings move between listing and
  // filling — they could have spent the units on a room, or sold them at the
  // door. Checked here, immediately before the transfer, because that is the
  // only check that protects the buyer.
  if (unitsHeld(listing.symbol, listing.sellerPubkey) < units) {
    return { ok: false, reason: "seller_short" };
  }

  try {
    db.transaction(() => {
      // Replay guard: `tx_id` is UNIQUE, so a second submission of the same
      // broadcast throws here rather than moving units twice.
      db.prepare(
        `INSERT INTO listing_fills (listing_id, buyer_pubkey, units, paid_sats, tx_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(listingId, pubkey, units, verdict.paidSats, verdict.txid);
      db.prepare("UPDATE listings SET units_sold = units_sold + ? WHERE id = ?").run(
        units,
        listingId
      );
      if (!transferUnits(listing.symbol, listing.sellerPubkey, pubkey, units)) {
        throw new Error("transfer_failed");
      }
    })();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return { ok: false, reason: "replay" };
    return { ok: false, reason: "seller_short" };
  }

  return { ok: true, units };
}

/**
 * The cheapest second-hand ticket for each symbol.
 *
 * ⚠ THE MARKET PAGE AND THE DOOR BOTH NEED THIS, and they need the SAME number.
 * The mint price is a ceiling — nobody rationally pays more second-hand than a
 * fresh unit costs — so an ask below it is the whole point of the market
 * existing, and a buyer who is not shown it is being overcharged by the
 * interface rather than by the seller.
 */
export async function getCheapestAsks(symbols: string[]): Promise<Record<string, number>> {
  const wanted = symbols.map(canonicalTicker).filter(isValidTicker);
  const out: Record<string, number> = {};
  for (const [symbol, ask] of cheapestAsks(wanted)) out[symbol] = ask;
  return out;
}

/** Record `pubkey`'s address, if it is not already known. Never throws. */
async function rememberAddressFor(pubkey: unknown): Promise<void> {
  if (typeof pubkey !== "string" || !pubkey) return;
  try {
    const { PublicKey } = await getBsvSdk();
    const address = PublicKey.fromString(pubkey).toAddress().toString();
    db.prepare("INSERT OR IGNORE INTO identity_addresses (address, pubkey) VALUES (?, ?)").run(
      address,
      pubkey
    );
  } catch {
    // A convenience index, not a durable fact. A failure here costs a locked
    // reader one unlock, not their post.
  }
}

/**
 * The key a viewer is asking as.
 *
 * ⚠ AN ADDRESS IS ACCEPTED BECAUSE A LOCKED WALLET HAS ONE AND A PUBKEY IT DOES
 * NOT. The pubkey wins when present; otherwise the address is resolved through
 * the map. Both are public identifiers, and this decides READ access only —
 * posting still needs a signature, so nothing here can be used to write.
 */
function resolveViewer(pubkey?: string | null, address?: string | null): string | null {
  if (typeof pubkey === "string" && pubkey) return pubkey;
  if (typeof address !== "string" || !address) return null;
  const row = db.prepare("SELECT pubkey FROM identity_addresses WHERE address = ?").get(address) as
    | { pubkey: string }
    | undefined;
  return row?.pubkey ?? null;
}

export interface RoomPosition {
  symbol: string;
  /** Units held right now. */
  units: number;
  /** What was paid for the units whose price IS recorded. */
  spentSats: number;
  /** Units with a recorded price. Below `units` where history is missing. */
  pricedUnits: number;
  /** Received from units already sold on the market. */
  receivedSats: number;
  /** What minting a fresh unit costs today — the last-resort price. */
  mintPriceSats: number;
  /** Units this holder currently has on offer. */
  listedUnits: number;
  /**
   * What entry cost this member, from the burn that admitted them.
   *
   * ⚠ NULL MEANS "NOT KNOWN", NOT "FREE". Members grandfathered in from
   * hold-to-enter never burned anything, so there is no entry price to report —
   * and neither does an entry whose row predates the price being recorded.
   * Inventing one from today's curve would show somebody a fabricated gain.
   */
  entryPaidSats: number | null;
}

/**
 * A holder's position in one room: what they hold, what it cost, what it is
 * worth if they had to replace it.
 *
 * ⚠ IT REPORTS WHAT IT DOES NOT KNOW. Units minted before the price was recorded
 * have no cost, and `pricedUnits` says how many. Inventing a basis for them —
 * by pricing them at today's curve, say — would put a fabricated profit in front
 * of somebody, which is a worse failure than a gap they can see.
 */
export async function getRoomPosition(
  symbol: string,
  pubkeyOrNull: string | null,
  address?: string | null
): Promise<RoomPosition | null> {
  const canonical = canonicalTicker(symbol);
  // Resolved the same way the door is, so a locked holder sees their own
  // position rather than nothing.
  const pubkey = resolveViewer(pubkeyOrNull, address);
  if (!isValidTicker(canonical) || !pubkey) return null;

  const minted = db
    .prepare(
      `SELECT COALESCE(SUM(paid_sats), 0) AS spent,
              COALESCE(SUM(CASE WHEN paid_sats IS NOT NULL THEN units ELSE 0 END), 0) AS priced
         FROM ticker_mentions WHERE symbol = ? AND pubkey = ?`
    )
    .get(canonical, pubkey) as { spent: number; priced: number };

  // Units bought on the market carry their price where the payment was actually
  // verified, so the two sources are summed rather than one standing in for both.
  const bought = db
    .prepare(
      `SELECT COALESCE(SUM(f.paid_sats), 0) AS spent, COALESCE(SUM(f.units), 0) AS units
         FROM listing_fills f JOIN listings l ON l.id = f.listing_id
        WHERE l.symbol = ? AND f.buyer_pubkey = ?`
    )
    .get(canonical, pubkey) as { spent: number; units: number };

  const sold = db
    .prepare(
      `SELECT COALESCE(SUM(f.paid_sats), 0) AS received
         FROM listing_fills f JOIN listings l ON l.id = f.listing_id
        WHERE l.symbol = ? AND l.seller_pubkey = ?`
    )
    .get(canonical, pubkey) as { received: number };

  return {
    symbol: canonical,
    units: unitsHeld(canonical, pubkey),
    spentSats: minted.spent + bought.spent,
    pricedUnits: minted.priced + bought.units,
    receivedSats: sold.received,
    // Minted, never held — a burn must not make the next unit cheaper.
    mintPriceSats: mintPriceSats(mintedUnits(canonical)),
    listedUnits: unitsCommitted(canonical, pubkey),
    entryPaidSats:
      (
        db
          .prepare("SELECT paid_sats FROM room_entries WHERE symbol = ? AND pubkey = ?")
          .get(canonical, pubkey) as { paid_sats: number | null } | undefined
      )?.paid_sats ?? null,
  };
}

export async function getPostById(id: number): Promise<Post | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(Math.floor(id)) as Post | undefined;
  return row ?? null;
}

export async function getThread(
  rootId: number,
  viewer?: string | null,
  address?: string | null
): Promise<Post[]> {
  if (!Number.isInteger(rootId) || rootId <= 0) return [];

  /**
   * ⚠ A ROOM'S MESSAGES ARE NOT SENT TO SOMEBODY WITHOUT A TICKET.
   *
   * `ThreadView` filters the replies out of its render for a locked reader —
   * but filtering in the component leaves the text in the payload the browser
   * already received, which is a gate made of CSS. The same mistake the feed's
   * reply preview made, one layer up.
   *
   * The root is still returned: it is public, it is in the feed, and it is what
   * somebody clicked to get here. What a ticket buys is the conversation.
   *
   * ⚠ THE HONEST LIMIT, unchanged (see room-access.ts): `viewer` arrives
   * unsigned and holdings are public, so a determined caller can pass a
   * holder's key. This is an access rule for the app, not secrecy — the posts
   * are on chain and readable by anyone who indexes them. What it does mean is
   * that the ordinary path no longer hands a room's contents to people who have
   * not paid, which is a different and much lower bar than "cannot be defeated".
   */
  if (!mayEnter(rootId, resolveViewer(viewer, address))) {
    const root = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(rootId) as Post | undefined;
    return root ? [root] : [];
  }
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
      -- ⚠ MUST MATCH POST_SELECT's reply_count EXACTLY, addendum filter included.
      -- (No backticks in this comment -- it lives inside a template literal.)
      -- This is the live count the feed polls; if the two drift, a post shows one
      -- number on load and a different one five seconds later.
      SELECT root_id, COUNT(*) as reply_count FROM posts
       WHERE parent_id IS NOT NULL AND COALESCE(is_addendum, 0) = 0 GROUP BY root_id
    ) rc
      ON rc.root_id = p.id
    WHERE p.id IN (${placeholders})
  `)
    .all(...ids) as { id: number; boot_count: number; reply_count: number }[];
}

/**
 * Link previews that have landed for posts the client already has on screen.
 *
 * ⚠ A PREVIEW *NEEDS* THIS CHANNEL, for the same reason reply counts do. The
 * unfurl is fire-and-forget from `createPost`, so it finishes AFTER the post row
 * exists — and typically after the poll 500ms later has already delivered that
 * row. Nothing then re-fetches it: `getNewPosts` only returns posts newer than
 * the client's high-water mark, and `getUpdatedPosts` is asked only about posts
 * MISSING a tx_id, which a paid post never is. So the author watched their own
 * link sit bare until they reloaded, while the preview was in the database the
 * whole time.
 *
 * Returns `preview_status` too, and rows are returned whether the unfurl
 * SUCCEEDED or failed: a recorded failure is the answer that stops the client
 * asking again, and dropping it would leave those posts polling forever.
 */
export async function getPostPreviews(ids: number[]): Promise<PostPreviewUpdate[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`
    SELECT p.id,
           lp.url         as preview_url,
           lp.title       as preview_title,
           lp.description as preview_description,
           lp.image_url   as preview_image,
           lp.site_name   as preview_site_name,
           lp.status      as preview_status
    FROM posts p
    JOIN link_previews lp ON lp.url_hash = p.preview_hash
    WHERE p.id IN (${placeholders})
  `)
    .all(...ids) as PostPreviewUpdate[];
}

export async function getBootboard(): Promise<BootboardData> {
  const current = db
    .prepare(`
    SELECT b.*, p.content, p.author_name, p.signature,
      pn.symbol AS author_nym, bn.symbol AS boosted_by_nym,
      -- The spotlight shows one post in full, so it gets the same unfurl card the
      -- feed does. Joined here rather than fetched by the component: the board is
      -- polled every 5s, and a second round trip per poll for one row is waste.
      lp.url         AS preview_url,
      lp.title       AS preview_title,
      lp.description AS preview_description,
      lp.image_url   AS preview_image,
      lp.site_name   AS preview_site_name,
      lp.status      AS preview_status
    FROM bootboard b
    JOIN posts p ON p.id = b.post_id
    LEFT JOIN link_previews lp ON lp.url_hash = p.preview_hash
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
