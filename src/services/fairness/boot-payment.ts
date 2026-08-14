/**
 * Multi-output BSV transaction builder for boot fee splits.
 * Single transaction: payer → all contributors + platform + OP_RETURN.
 */

import type { LockingScript } from "@bsv/sdk";
import { OP, P2PKH, Script } from "@bsv/sdk";
import { bootAuditPayload } from "@/lib/boot-audit";
import { type BroadcastResult, buildAndBroadcast } from "@/services/bsv/wallet";
import { FAIRNESS_CONFIG } from "./config";
import type { SplitResult } from "./split";

/**
 * Build and broadcast the split transaction for a boot.
 * Retries once after 1 second on failure (handles stale UTXO contention).
 *
 * @param booterAddress  Address that performed the boot — recorded in the
 *   on-chain audit record (this is a server-funded boot, so the tx inputs are
 *   the server wallet's; without this the booter would not appear on-chain).
 */
export async function buildSplitTransaction(
  split: SplitResult,
  postId: number,
  booterAddress: string
): Promise<BroadcastResult> {
  const p2pkh = new P2PKH();

  // Collect all payment outputs (deduplicate by address)
  const outputsByAddress = new Map<string, number>();

  // Platform output
  if (split.platform.sats > 0) {
    outputsByAddress.set(
      split.platform.address,
      (outputsByAddress.get(split.platform.address) ?? 0) + split.platform.sats
    );
  }

  // Creator bonus (if not already merged into pool entry)
  if (split.creatorBonus.sats > 0) {
    outputsByAddress.set(
      split.creatorBonus.address,
      (outputsByAddress.get(split.creatorBonus.address) ?? 0) + split.creatorBonus.sats
    );
  }

  // Pool shares
  for (const recipient of split.pool) {
    if (recipient.sats > 0) {
      outputsByAddress.set(
        recipient.address,
        (outputsByAddress.get(recipient.address) ?? 0) + recipient.sats
      );
    }
  }

  // Build transaction outputs
  const outputs: Array<{ lockingScript: LockingScript; satoshis: number }> = [];

  for (const [address, sats] of outputsByAddress) {
    if (sats > 0) {
      outputs.push({
        lockingScript: p2pkh.lock(address) as LockingScript,
        satoshis: sats,
      });
    }
  }

  // OP_RETURN audit trail (shared shape — see src/lib/boot-audit.ts)
  const auditPayload = bootAuditPayload({
    postId,
    booter: booterAddress,
    funded: "server",
    total: split.totalDistributed,
    recipients: outputsByAddress.size,
    formulaVersion: FAIRNESS_CONFIG.formulaVersion,
  });

  const opReturnScript = new Script();
  opReturnScript.writeOpCode(OP.OP_FALSE);
  opReturnScript.writeOpCode(OP.OP_RETURN);
  opReturnScript.writeBin(Array.from(new TextEncoder().encode(auditPayload)));

  outputs.push({
    lockingScript: opReturnScript as LockingScript,
    satoshis: 0,
  });

  const result = await buildAndBroadcast(outputs);
  if (result.status === "success") return result;

  // A broadcast TIMEOUT is INDETERMINATE (the tx may have landed at ARC) — NEVER
  // retry, because the retry rebuilds a NEW tx and the server would DOUBLE-PAY.
  // Return it as terminal; executeBoot treats it as no-refund/no-rebuild (the
  // grant was already consumed). The other failures (insufficient_funds, source-tx
  // fetch failure, ARC rejection) did NOT broadcast, so the 1s retry below is safe.
  // See DECISIONS.md "Free-boot path consumes the grant BEFORE paying" + Phase 2.
  if (result.status === "broadcast_timeout" || result.status === "spend_disabled") return result;

  // First attempt failed — wait 1s and retry once with fresh UTXO state.
  // The mutex ensures the retry waits for any in-flight transaction to finish.
  // Common cause: stale WoC data returned an already-spent UTXO.
  console.warn(
    `OpenBooks: boot split first attempt failed for post ${postId}, retrying in 1s...`,
    result
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return buildAndBroadcast(outputs);
}
