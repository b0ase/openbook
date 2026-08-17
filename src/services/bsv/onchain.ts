/**
 * On-chain post logging via OP_RETURN.
 * Each post gets an OP_FALSE OP_RETURN transaction with its data.
 */

import type { LockingScript } from "@bsv/sdk";
import { OP, Script } from "@bsv/sdk";
import { onchainRecord } from "@/lib/onchain-record";
import { type BroadcastResult, buildAndBroadcast } from "./wallet";

interface PostData {
  /**
   * The post's own SQLite rowid. Written on-chain so a record is
   * self-identifying — see the `id`/`parent` note in `logPostOnChain`.
   */
  id: number;
  content: string;
  author: string;
  signature: string | null;
  pubkey: string | null;
  /** Immediate parent's rowid; null for a thread root (THREADS.md). */
  parent: number | null;
}

/**
 * Log a post on-chain via OP_RETURN.
 * Returns txid on success, null on failure.
 * Retries once after 1 second on failure (handles UTXO contention).
 * Failures are non-fatal — the post still exists in SQLite.
 *
 * ⚠ `id` AND `parent` TRAVEL TOGETHER. THREADS.md's on-chain step specifies only
 * `parent`, but a post record carried no identifier of its own, so a lone
 * `parent: 42` would point at a row nobody reading the chain could locate — the
 * thread graph would still be reconstructible only from SQLite, which is the one
 * thing that step exists to fix. Writing the post's own rowid alongside it makes
 * the pointer resolvable from the chain, and matches the convention `boot_split`
 * already uses (`post_id` = a per-app rowid, keyed as `(app, post_id)`).
 *
 * Both are additive optional fields, so `v` stays 1 per the reader contract in
 * `lib/onchain-record.ts`. Records written before this carry neither; a reader
 * treats their absence as "unknown", not as "root". `parent` is emitted as an
 * explicit `null` for roots rather than omitted, so a root written by a
 * threading-aware writer is distinguishable from a pre-threading record.
 */
export async function logPostOnChain(postData: PostData): Promise<string | null> {
  const attempt = async (): Promise<BroadcastResult> => {
    const payload = onchainRecord("post", {
      id: postData.id,
      content: postData.content,
      author: postData.author,
      sig: postData.signature,
      pubkey: postData.pubkey,
      parent: postData.parent,
    });

    // Build OP_FALSE OP_RETURN script (BSV standard — provably unspendable)
    const opReturnScript = new Script();
    opReturnScript.writeOpCode(OP.OP_FALSE);
    opReturnScript.writeOpCode(OP.OP_RETURN);
    opReturnScript.writeBin(Array.from(new TextEncoder().encode(payload)));

    return buildAndBroadcast([
      {
        lockingScript: opReturnScript as LockingScript,
        satoshis: 0,
      },
    ]);
  };

  try {
    const result = await attempt();
    if (result.status === "success") return result.txid;

    // A broadcast TIMEOUT is indeterminate (the OP_RETURN may have landed) — do
    // NOT retry it INLINE here. The post stays tx_id=NULL and the durable anchor
    // sweep (anchor-sweep.ts) re-attempts it later. Posts may safely re-broadcast
    // on timeout (unlike boots) — a post-log has no payee, so a rare duplicate is
    // one wasted ~66-sat OP_RETURN, not a double-pay. See DECISIONS.md
    // "Durable post-retry: timeout => re-sweep". spend_disabled likewise stays
    // NULL and is re-swept once spending is re-enabled.
    if (result.status === "broadcast_timeout" || result.status === "spend_disabled") return null;

    // First attempt failed — wait 1s and retry once with fresh UTXO state.
    // The mutex ensures the retry waits for any in-flight transaction to finish.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const retry = await attempt();
    return retry.status === "success" ? retry.txid : null;
  } catch (e) {
    console.error("OpenBook: on-chain logging failed", e);
    return null;
  }
}

/**
 * Record a room entry on chain — the receipt for a burned ticket.
 *
 * ⚠ THIS IS WHAT MAKES MEMBERSHIP CHECKABLE BY SOMEBODY WHO DOES NOT TRUST US.
 * Entry destroys a unit, so a holdings query can no longer prove a member paid;
 * `room_entries` can, but only to whoever believes our database. This record is
 * the same fact written somewhere we cannot edit, naming the room, the member and
 * what the door charged.
 *
 * ⚠ BEST-EFFORT, AND THE MEMBERSHIP IS NOT. The ticket is already destroyed by the
 * time this runs, so a failed broadcast must not fail the entry — that would take
 * somebody's ticket and give them nothing. Same trade `logPostOnChain` makes, for
 * the same reason, with one difference worth knowing: **there is no sweep for
 * these yet.** A post that fails to anchor is retried by `anchor-sweep.ts`
 * because `tx_id IS NULL` is a queue; a room entry has no equivalent, so a
 * failure here means that entry is recorded only in SQLite. Acceptable while the
 * database is the authority anyway (see DECISIONS.md "Entry BURNS the ticket"),
 * and the obvious thing to add when it stops being.
 *
 * ⚠ NEW FIELDS ONLY, SO `v` STAYS 1 — per the reader contract in
 * `lib/onchain-record.ts`. `type: "room_entry"` is the discriminator; a reader
 * that does not know it ignores the record rather than choking on it.
 */
export async function logRoomEntryOnChain(entry: {
  symbol: string;
  /** The member's pubkey — the same key that signed for the burn. */
  member: string;
  /** What a ticket cost at the moment the door was passed. */
  paidSats: number;
}): Promise<string | null> {
  try {
    const payload = onchainRecord("room_entry", {
      symbol: entry.symbol,
      member: entry.member,
      paid: entry.paidSats,
      // The unit is gone, and saying so explicitly is the point of the record —
      // a reader must not mistake this for a transfer to some burn address.
      burned: 1,
    });

    const opReturnScript = new Script();
    opReturnScript.writeOpCode(OP.OP_FALSE);
    opReturnScript.writeOpCode(OP.OP_RETURN);
    opReturnScript.writeBin(Array.from(new TextEncoder().encode(payload)));

    const result = await buildAndBroadcast([
      { lockingScript: opReturnScript as LockingScript, satoshis: 0 },
    ]);
    return result.status === "success" ? result.txid : null;
  } catch (e) {
    console.error("OpenBook: room-entry logging failed", e);
    return null;
  }
}
