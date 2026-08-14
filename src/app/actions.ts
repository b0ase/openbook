"use server";

import { headers } from "next/headers";
import { screenContent } from "@/lib/content-filter";
import { db } from "@/lib/db";
import { tryConsumeFreeBootForIp } from "@/lib/free-boot-cap";
import { rateLimit } from "@/lib/rate-limit";
import {
  FREE_BOOT_COST_SATS,
  hasDailyBudget,
  POST_LOG_COST_SATS,
  recordDailySpend,
} from "@/lib/server-spend-budget";
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
    | "rejected_content";
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

  const result = db
    .prepare("INSERT INTO posts (content, author_name, signature, pubkey) VALUES (?, ?, ?, ?)")
    .run(
      content.trim(),
      authorName,
      typeof signature === "string" ? signature : null,
      typeof pubkey === "string" ? pubkey : null
    );

  // Fire-and-forget: log on-chain, update tx_id if successful
  const postId = result.lastInsertRowid as number;
  const trimmedContent = content.trim();
  const sigStr = typeof signature === "string" ? signature : null;
  const pkStr = typeof pubkey === "string" ? pubkey : null;

  logPostOnChain({ content: trimmedContent, author: authorName, signature: sigStr, pubkey: pkStr })
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

  return { ok: true };
}

export async function getPosts(beforeId?: number): Promise<Post[]> {
  if (beforeId !== undefined) {
    return db
      .prepare(`
      SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
      FROM posts p
      LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
        ON bc.post_id = p.id
      WHERE p.id < ?
      ORDER BY p.id DESC
      LIMIT 100
    `)
      .all(beforeId) as Post[];
  }
  return db
    .prepare(`
    SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    ORDER BY p.id DESC
    LIMIT 100
  `)
    .all() as Post[];
}

export async function getNewPosts(sinceId: number): Promise<Post[]> {
  if (!Number.isInteger(sinceId) || sinceId < 0) return [];
  return db
    .prepare(`
    SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    WHERE p.id > ?
    ORDER BY p.id DESC
  `)
    .all(sinceId) as Post[];
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
    .prepare(`
    SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    WHERE p.id IN (${placeholders}) AND p.tx_id IS NOT NULL
    ORDER BY p.id DESC
  `)
    .all(...knownIds) as Post[];
}

export async function getOlderPosts(beforeId: number): Promise<Post[]> {
  if (!Number.isInteger(beforeId) || beforeId <= 0) return [];
  return getPosts(beforeId);
}

/** Oldest 100 posts, ascending (id 1 first) — the ORIGIN window. */
export async function getOldestPosts(): Promise<Post[]> {
  return db
    .prepare(`
    SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    ORDER BY p.id ASC
    LIMIT 100
  `)
    .all() as Post[];
}

/** Next 100 posts NEWER than afterId, ascending — ORIGIN mode reads forward. */
export async function getForwardPosts(afterId: number): Promise<Post[]> {
  if (!Number.isInteger(afterId) || afterId < 0) return [];
  return db
    .prepare(`
    SELECT p.*, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    WHERE p.id > ?
    ORDER BY p.id ASC
    LIMIT 100
  `)
    .all(afterId) as Post[];
}

/**
 * Authoritative boot counts for a set of (confirmed, visible) posts. Lets the
 * feed poll refresh counts that change from ANY boot source — Bootboard re-boot,
 * another user, a server-funded free boost — not just this client's optimistic
 * +1. Lightweight: returns only `id` + `boot_count`, no post bodies.
 */
export async function getPostCounts(ids: number[]): Promise<{ id: number; boot_count: number }[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`
    SELECT p.id, COALESCE(bc.boot_count, 0) as boot_count
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    WHERE p.id IN (${placeholders})
  `)
    .all(...ids) as { id: number; boot_count: number }[];
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
