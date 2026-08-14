/**
 * On-chain post logging via OP_RETURN.
 * Each post gets an OP_FALSE OP_RETURN transaction with its data.
 */

import type { LockingScript } from "@bsv/sdk";
import { OP, Script } from "@bsv/sdk";
import { onchainRecord } from "@/lib/onchain-record";
import { type BroadcastResult, buildAndBroadcast } from "./wallet";

interface PostData {
  content: string;
  author: string;
  signature: string | null;
  pubkey: string | null;
}

/**
 * Log a post on-chain via OP_RETURN.
 * Returns txid on success, null on failure.
 * Retries once after 1 second on failure (handles UTXO contention).
 * Failures are non-fatal — the post still exists in SQLite.
 */
export async function logPostOnChain(postData: PostData): Promise<string | null> {
  const attempt = async (): Promise<BroadcastResult> => {
    const payload = onchainRecord("post", {
      content: postData.content,
      author: postData.author,
      sig: postData.signature,
      pubkey: postData.pubkey,
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
