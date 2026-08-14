/**
 * Durable on-chain anchoring sweep.
 *
 * Guarantees the locked invariant: every accepted post eventually carries a
 * `tx_id` (lands on-chain) — no off-chain orphans. The "queue" is simply posts
 * with `tx_id IS NULL`, which is durable across restarts because it lives in
 * SQLite. Rather than a dedicated timer/worker, the sweep is driven
 * opportunistically by ambient traffic (createPost + the feed poll): a live site
 * drains stragglers continuously; a dead site has nobody waiting on an anchor.
 * Single-flight + one broadcast per sweep, so it never contends beyond the
 * wallet mutex's natural serialization.
 *
 * Posts re-broadcast after a prior broadcast_timeout (unlike boots): a post-log
 * has no payee, so the worst case of a duplicate is one wasted ~66-sat OP_RETURN,
 * NOT a double-pay. See DECISIONS.md "Durable post-retry: timeout => re-sweep".
 */
import { db as defaultDb } from "@/lib/db";
import { POST_LOG_COST_SATS, recordDailySpend } from "@/lib/server-spend-budget";
import { logPostOnChain } from "./onchain";

type DB = typeof defaultDb;

interface OrphanRow {
  id: number;
  content: string;
  author_name: string;
  signature: string | null;
  pubkey: string | null;
  /**
   * ⚠ MUST be selected and forwarded. The sweep is the ONLY path that anchors a
   * post whose inline broadcast failed, and an OP_RETURN is immutable — a reply
   * swept without its parent is unthreadable from the chain forever, with no
   * second chance to correct it.
   */
  parent_id: number | null;
}

// Only sweep posts old enough that their inline first attempt (up to a 30s
// broadcast timeout + 1s + a 30s retry) has definitely finished — avoids the
// sweep racing an in-flight inline broadcast and double-anchoring routinely.
const MIN_AGE_SECONDS = 90;
const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let sweepInFlight = false;
// postId -> earliest retry ts (ms). In-memory: lost on restart, which just means
// an immediate retry after a deploy (desirable — a deploy may be the fix). No
// thundering herd: single-flight + one broadcast per sweep.
const nextAttemptAt = new Map<number, number>();
const attemptCount = new Map<number, number>();

/**
 * Drain one straggler from the un-anchored queue. Fire-and-forget; never throws.
 * Safe to call on every request — single-flight makes concurrent calls no-ops.
 */
export async function sweepOrphans(db: DB = defaultDb): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const rows = db
      .prepare(
        `SELECT id, content, author_name, signature, pubkey, parent_id
         FROM posts
         WHERE tx_id IS NULL AND created_at < datetime('now', ?)
         ORDER BY id ASC
         LIMIT 20`
      )
      .all(`-${MIN_AGE_SECONDS} seconds`) as OrphanRow[];

    const now = Date.now();
    for (const row of rows) {
      if (now < (nextAttemptAt.get(row.id) ?? 0)) continue; // backoff not elapsed
      const txid = await logPostOnChain({
        id: row.id,
        content: row.content,
        author: row.author_name,
        signature: row.signature,
        pubkey: row.pubkey,
        parent: row.parent_id,
      });
      if (txid) {
        db.prepare("UPDATE posts SET tx_id = ? WHERE id = ?").run(txid, row.id);
        recordDailySpend(POST_LOG_COST_SATS);
        nextAttemptAt.delete(row.id);
        attemptCount.delete(row.id);
      } else {
        // Failed (dry wallet / kill-switch / ARC down) — back off, never give up.
        const n = (attemptCount.get(row.id) ?? 0) + 1;
        attemptCount.set(row.id, n);
        nextAttemptAt.set(
          row.id,
          Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS)
        );
      }
      // One real broadcast per sweep — keep mutex contention minimal; the next
      // ambient tick takes the next orphan.
      break;
    }
  } catch (e) {
    console.error("OpenBook: orphan anchor sweep failed", e);
  } finally {
    sweepInFlight = false;
  }
}

/** Count of posts still awaiting an on-chain anchor (observability). */
export function pendingAnchorCount(db: DB = defaultDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE tx_id IS NULL").get() as {
    n: number;
  };
  return row.n;
}
