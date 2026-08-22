import { db as defaultDb } from "@/lib/db";
import { type PendingMint, pendingMints, recordMint } from "@/lib/mint-queue";
import { hasDailyBudget, recordDailySpend } from "@/lib/server-spend-budget";

type DB = typeof defaultDb;

/**
 * Draining the mint queue — the sweep that turns a paid-for naming into units
 * the network has actually issued.
 *
 * ⚠ THIS IS WHERE SERIALIZATION IS SOLVED, AND IT IS SOLVED BY NOT HAVING ANY.
 * A covenant is ONE UTXO: every mint spends it and re-creates it, so mints of
 * the same word form a strict chain. Two browsers building from the same
 * outpoint means one of them is a double-spend. Rather than hand out leases and
 * hope, exactly one process holds each covenant — this one — and contention
 * cannot arise. See DECISIONS "Minting is DECOUPLED from posting".
 *
 * ⚠ ONE BROADCAST PER TICK, driven by ambient traffic, exactly like
 * `anchor-sweep.ts`. A live site drains continuously; a dead site has nobody
 * waiting. No worker, no timer, no schema for a queue.
 *
 * ⚠ GATING MEANS DEFER, NEVER DROP. The author was charged the mint price when
 * they posted, so the units are a debt. A dry wallet, a tripped daily ceiling
 * or a dead broadcaster all mean *later* — there is no branch here that
 * abandons a row, and there must never be one.
 */

/** The work of minting one naming, so the wallet stays the only place that spends. */
export interface MintJob extends PendingMint {
  /** Address the units are minted to — derived from the naming author's key. */
  minterAddress: string;
}

export type MintOutcome =
  | {
      status: "minted";
      txid: string;
      /** Output index carrying the units. */
      vout: number;
      nextOutpoint: string;
      nextScript: string;
      /** What the miner took, for the daily ceiling. */
      feeSats: number;
    }
  /** Try again later — a dry wallet, a kill-switch, an unreachable broadcaster. */
  | { status: "deferred"; reason: string }
  /** This job cannot succeed as it stands and should back off hard. */
  | { status: "failed"; reason: string };

export type MintExecutor = (job: MintJob) => Promise<MintOutcome>;

/** Derive the address that owns a naming's units from the key that signed it. */
export async function minterAddressFor(pubkey: string): Promise<string | null> {
  try {
    const { PublicKey } = await import("@bsv/sdk");
    return PublicKey.fromString(pubkey).toAddress();
  } catch {
    /**
     * ⚠ AN UNPARSEABLE KEY IS A PERMANENT FAILURE, NOT A TRANSIENT ONE. There is
     * no address to mint to and no later attempt will invent one. Returning null
     * lets the sweep skip the row instead of retrying it forever at the head of
     * an oldest-first queue, where it would block every naming behind it.
     */
    return null;
  }
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * A generous upper bound on what one mint costs the platform in miner fees.
 *
 * ⚠ THE COVENANT CARRIES ITS OWN 24KB SCRIPT TWICE — once as the output it
 * re-creates and once inside the sighash preimage — so a mint transaction is
 * ~48KB and ~5,300 satoshis at 110 sat/kB, whatever the number of units. This
 * is the figure the daily ceiling is checked against BEFORE spending; the real
 * fee is recorded after. See DECISIONS "The 24KB covenant is a 20-digit
 * number-to-string conversion".
 */
export const MINT_FEE_ESTIMATE_SATS = 6000;

let sweepInFlight = false;
const nextAttemptAt = new Map<number, number>();
const attemptCount = new Map<number, number>();

function backOff(mentionId: number): void {
  const n = (attemptCount.get(mentionId) ?? 0) + 1;
  attemptCount.set(mentionId, n);
  nextAttemptAt.set(
    mentionId,
    Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS)
  );
}

function clearBackOff(mentionId: number): void {
  nextAttemptAt.delete(mentionId);
  attemptCount.delete(mentionId);
}

/**
 * Drain one owed mint. Fire-and-forget; never throws.
 *
 * Returns what it did, so callers that care (tests, observability) can see it
 * without the sweep needing to log.
 */
export async function sweepMints(
  execute: MintExecutor,
  db: DB = defaultDb
): Promise<{ swept: number; outcome?: MintOutcome["status"] | "skipped" }> {
  if (sweepInFlight) return { swept: 0 };
  sweepInFlight = true;
  try {
    /**
     * ⚠ CHECKED BEFORE ANY WORK, AND IT ROUTES TO LATER RATHER THAN TO A DROP.
     * Reaching the ceiling means the platform stops spending today; it does not
     * mean anybody stops being owed their units.
     */
    if (!hasDailyBudget(MINT_FEE_ESTIMATE_SATS)) return { swept: 0, outcome: "deferred" };

    const jobs = pendingMints(20, db);
    const now = Date.now();

    for (const job of jobs) {
      if (now < (nextAttemptAt.get(job.mentionId) ?? 0)) continue;

      // A word whose covenant we have lost track of cannot be spent from. Skip
      // it rather than guess at a script — a wrong one spends nothing and a
      // right-looking wrong one is worse.
      if (!job.contractScript || !job.contractOutpoint) {
        backOff(job.mentionId);
        continue;
      }
      if (!job.pubkey) continue;
      const minterAddress = await minterAddressFor(job.pubkey);
      if (!minterAddress) {
        // Permanent: back off to the maximum rather than spin.
        attemptCount.set(job.mentionId, 99);
        nextAttemptAt.set(job.mentionId, Date.now() + MAX_BACKOFF_MS);
        continue;
      }

      const outcome = await execute({ ...job, minterAddress });

      if (outcome.status === "minted") {
        recordMint(
          {
            mentionId: job.mentionId,
            symbol: job.symbol,
            txid: outcome.txid,
            vout: outcome.vout,
            nextOutpoint: outcome.nextOutpoint,
            nextScript: outcome.nextScript,
          },
          db
        );
        recordDailySpend(outcome.feeSats);
        clearBackOff(job.mentionId);
      } else {
        backOff(job.mentionId);
      }

      // One broadcast per tick — the next ambient request takes the next one.
      return { swept: outcome.status === "minted" ? 1 : 0, outcome: outcome.status };
    }
    return { swept: 0, outcome: "skipped" };
  } catch (e) {
    console.error("OpenBooks: mint sweep failed", e);
    return { swept: 0 };
  } finally {
    sweepInFlight = false;
  }
}

/** Test seam: the backoff map is module state and would leak between cases. */
export function __resetMintSweepState(): void {
  nextAttemptAt.clear();
  attemptCount.clear();
  sweepInFlight = false;
}
