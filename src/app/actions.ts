"use server";

import { headers } from "next/headers";
import { screenContent } from "@/lib/content-filter";
import { db } from "@/lib/db";
import { tryConsumeFreeBootForIp } from "@/lib/free-boot-cap";
import {
  attachPreviewToPost,
  firstLinkIn,
  hasPreview,
  savePreview,
  urlHash,
} from "@/lib/link-preview-store";
import { rateLimit } from "@/lib/rate-limit";
import {
  FREE_BOOT_COST_SATS,
  hasDailyBudget,
  POST_LOG_COST_SATS,
  recordDailySpend,
} from "@/lib/server-spend-budget";
import { distinctTickers, isValidTicker } from "@/lib/ticker";
import { generateAnonName } from "@/lib/utils";

async function getBsvSdk() {
  const { PublicKey, Signature } = await import("@bsv/sdk");
  return { PublicKey, Signature };
}

import { sweepOrphans } from "@/services/bsv/anchor-sweep";
import { logPostOnChain } from "@/services/bsv/onchain";
import { isServerSpendDisabled } from "@/services/bsv/wallet";
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
    | "invalid_parent";
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
    }): number => {
      const res = db
        .prepare(
          "INSERT INTO posts (content, author_name, signature, pubkey, parent_id, root_id) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(args.content, args.author, args.sig, args.pk, args.parent, args.root);
      const id = res.lastInsertRowid as number;
      if (args.root === null) {
        db.prepare("UPDATE posts SET root_id = id WHERE id = ?").run(id);
      }
      return id;
    }
  );

  const postId = insertPost({
    content: content.trim(),
    author: authorName,
    sig: typeof signature === "string" ? signature : null,
    pk: typeof pubkey === "string" ? pubkey : null,
    parent: parentId,
    root: rootId,
  });

  // Claim any `$Ticker` in the post — FIRST CLAIM WINS, enforced by the PRIMARY
  // KEY (see applyTickerMigration). Synchronous and inside the request, unlike
  // the on-chain log and the unfurl: those are caches of work that can be redone,
  // whereas a claim decides who owns a name and a race would hand it to whoever
  // the event loop happened to favour.
  registerTickers(postId, rootId ?? postId, content.trim(), pubkey);

  // Fire-and-forget: log on-chain, update tx_id if successful
  const trimmedContent = content.trim();
  const sigStr = typeof signature === "string" ? signature : null;
  const pkStr = typeof pubkey === "string" ? pubkey : null;

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
function registerTickers(
  postId: number,
  rootId: number,
  content: string,
  pubkey: FormDataEntryValue | null
): void {
  try {
    const symbols = distinctTickers(content);
    if (!symbols.length) return;
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO tickers (symbol, post_id, root_id, pubkey) VALUES (?, ?, ?, ?)"
    );
    const pk = typeof pubkey === "string" ? pubkey : null;
    const claimAll = db.transaction(() => {
      for (const symbol of symbols) stmt.run(symbol, postId, rootId, pk);
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
  const wanted = symbols.filter(isValidTicker);
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
 * The ticker a thread carries, if any — so a thread can be headlined by the name
 * it was claimed under rather than the generic word "Thread".
 *
 * A thread can in principle hold several (one post naming two symbols), so this
 * returns the FIRST claimed, which is the one that founded it.
 */
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
         lp.status      as preview_status
  FROM posts p
  LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
    ON bc.post_id = p.id
  LEFT JOIN (
    SELECT root_id, COUNT(*) as reply_count FROM posts WHERE parent_id IS NOT NULL GROUP BY root_id
  ) rc
    ON rc.root_id = p.id
  LEFT JOIN link_previews lp
    ON lp.url_hash = p.preview_hash
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

export async function getPosts(beforeId?: number): Promise<Post[]> {
  if (beforeId !== undefined) {
    return db
      .prepare(`${POST_SELECT} WHERE ${ROOTS_ONLY} AND p.id < ? ORDER BY p.id DESC LIMIT 100`)
      .all(beforeId) as Post[];
  }
  return db
    .prepare(`${POST_SELECT} WHERE ${ROOTS_ONLY} ORDER BY p.id DESC LIMIT 100`)
    .all() as Post[];
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
  return db
    .prepare(`${POST_SELECT} WHERE p.root_id = ? ORDER BY p.id ASC LIMIT 500`)
    .all(rootId) as Post[];
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

export async function getOlderPosts(beforeId: number): Promise<Post[]> {
  if (!Number.isInteger(beforeId) || beforeId <= 0) return [];
  return getPosts(beforeId);
}

/** Oldest 100 posts, ascending (id 1 first) — the ORIGIN window. */
export async function getOldestPosts(): Promise<Post[]> {
  return db
    .prepare(`${POST_SELECT} WHERE ${ROOTS_ONLY} ORDER BY p.id ASC LIMIT 100`)
    .all() as Post[];
}

/** Next 100 posts NEWER than afterId, ascending — ORIGIN mode reads forward. */
export async function getForwardPosts(afterId: number): Promise<Post[]> {
  if (!Number.isInteger(afterId) || afterId < 0) return [];
  return db
    .prepare(`${POST_SELECT} WHERE ${ROOTS_ONLY} AND p.id > ? ORDER BY p.id ASC LIMIT 100`)
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
    SELECT b.*, p.content, p.author_name, p.signature
    FROM bootboard b
    JOIN posts p ON p.id = b.post_id
    WHERE b.held_until IS NULL
    ORDER BY b.booted_at DESC
    LIMIT 1
  `)
    .get() as BootboardRow | undefined;

  const history = db
    .prepare(`
    SELECT b.post_id, b.boosted_by, b.boosted_by_name, b.booted_at, b.held_until,
      CAST((julianday(b.held_until) - julianday(b.booted_at)) * 86400 AS INTEGER) as duration_seconds,
      p.content, p.author_name
    FROM bootboard b
    JOIN posts p ON p.id = b.post_id
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
