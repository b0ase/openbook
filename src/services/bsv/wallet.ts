/**
 * Server-side BSV wallet with UTXO management.
 * Supports reservation, 0-conf chaining, multi-UTXO aggregation.
 * Uses a promise-based mutex to prevent UTXO contention between
 * concurrent operations (post logging, boot splits).
 */

import { type LockingScript, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction } from "@bsv/sdk";

let _serverKey: PrivateKey | null = null;

// ── Transaction Mutex ──────────────────────────────────────────
// Only one buildAndBroadcast call executes at a time. Others queue.
let _txMutexChain: Promise<void> = Promise.resolve();

function acquireTxMutex(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Capture the current end of the chain as our "wait" point
  const ticket = _txMutexChain.then(() => {});
  // Extend the chain: next caller waits until we call release()
  _txMutexChain = _txMutexChain.then(() => gate);
  // When the previous operation finishes, hand back the release function
  return ticket.then(() => release);
}

function getServerKey(): PrivateKey | null {
  if (_serverKey) return _serverKey;
  const wif = process.env.BSV_SERVER_WIF;
  if (!wif) return null;
  try {
    _serverKey = PrivateKey.fromWif(wif);
    return _serverKey;
  } catch (e) {
    console.error("OpenBook: invalid BSV_SERVER_WIF", e);
    return null;
  }
}

export function getServerAddress(): string | null {
  const key = getServerKey();
  if (!key) return null;
  return key.toPublicKey().toAddress().toString();
}

/**
 * Phase 2 Build C — server-wallet kill-switch. When BSV_WALLET_SPEND_DISABLED is
 * truthy ("true"/"1"), the server wallet refuses to spend: free boots route to
 * PAID (checked pre-consume in executeBoot, so no grant is consumed) and
 * post-logging is skipped. Trips via an env var (needs a redeploy); a DB-backed
 * instant runtime toggle is the documented fast-follow. Paid/client boots are
 * UNAFFECTED — they spend the user's own funds, not the server wallet.
 */
export function isServerSpendDisabled(): boolean {
  const v = (process.env.BSV_WALLET_SPEND_DISABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

// ── Network timeouts (Phase 2 Build A) ─────────────────────────
// All four external calls below run INSIDE the wallet mutex, so an unbounded
// hang would wedge EVERY free boot + post-logging site-wide until the socket
// died. Read calls abort + fail safe (no money moved). The broadcast timeout is
// treated as INDETERMINATE — see buildAndBroadcast.
const READ_TIMEOUT_MS = 10_000;
const BROADCAST_TIMEOUT_MS = 30_000;

class TimeoutError extends Error {
  constructor() {
    super("operation timed out");
    this.name = "TimeoutError";
  }
}

/** fetch() with an AbortController deadline — aborts the request on timeout. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Race a promise against a deadline. Rejects with TimeoutError on timeout — the
 *  underlying promise is NOT cancelled (used for tx.broadcast(), where a timeout
 *  is indeterminate, not a cancellation: the tx may still land at ARC). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ── UTXO Types ──────────────────────────────────────────────

interface UTXO {
  tx_hash: string;
  tx_pos: number;
  value: number;
  sourceTransaction?: Transaction; // For 0-conf chaining
}

export type BroadcastResult =
  | { status: "success"; txid: string }
  | { status: "insufficient_funds" }
  | { status: "broadcast_failed"; error: string }
  // Broadcast timed out — INDETERMINATE: the tx may have landed at ARC. Callers
  // MUST treat this as terminal (no rebuild, no refund). See buildAndBroadcast.
  | { status: "broadcast_timeout" }
  // Server spending is disabled via the BSV_WALLET_SPEND_DISABLED kill-switch.
  | { status: "spend_disabled" }
  | { status: "no_wallet" };

/** Fee buffer reserved on top of the output total when selecting UTXOs. Exported
 *  so the free-boot balance precheck (boot-orchestrator, Build B) uses the SAME
 *  figure the broadcast path needs — keeps "can the wallet cover this boot?" in
 *  sync with reserveUtxos so the precheck never green-lights a boot that would
 *  then hit insufficient_funds and burn the grant. */
export const SERVER_FEE_BUFFER_SATS = 500;

// ── UTXO Manager ────────────────────────────────────────────

const _reserved = new Set<string>();
const _pendingChange: UTXO[] = []; // 0-conf change outputs from recent txs
const _spent = new Set<string>(); // UTXOs consumed as inputs — blacklist for stale WoC data

function utxoKey(txHash: string, txPos: number): string {
  return `${txHash}:${txPos}`;
}

/**
 * Thrown ONLY when `strict` is requested and the UTXO set could not be read.
 *
 * ⚠ The distinction this exists to preserve: an unreadable wallet and an empty
 * wallet are NOT the same fact, and the non-strict path cannot tell them apart
 * (it degrades to `_pendingChange`, which is empty after a restart — so a WoC
 * blip reads as a balance of 0). Spending callers WANT that degradation, since
 * refusing to spend is the safe direction. Reporting callers must not have it:
 * see `/api/health`, which would otherwise raise `wallet_low` — a critical,
 * operator-paging alarm — every time WhatsOnChain hiccups.
 */
export class BalanceUnavailableError extends Error {
  constructor(cause: string) {
    super(`wallet balance unavailable: ${cause}`);
    this.name = "BalanceUnavailableError";
  }
}

/**
 * @param opts.strict Throw `BalanceUnavailableError` instead of silently
 * degrading to `_pendingChange` when WhatsOnChain cannot be read. Only for
 * callers that REPORT the balance; never for callers that spend it.
 */
export async function getUtxos(neededSats?: number, opts?: { strict?: boolean }): Promise<UTXO[]> {
  const address = getServerAddress();
  // Not a read failure — health reports `addressConfigured` separately, and a
  // wallet with no key genuinely holds nothing.
  if (!address) return [];

  // If we have pending change UTXOs with enough value, skip the WoC fetch
  // to avoid stale data and reduce API calls.
  if (neededSats !== undefined && _pendingChange.length > 0) {
    const pendingTotal = _pendingChange
      .filter((u) => !_reserved.has(utxoKey(u.tx_hash, u.tx_pos)))
      .reduce((sum, u) => sum + u.value, 0);
    if (pendingTotal >= neededSats) {
      return [..._pendingChange];
    }
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`,
      READ_TIMEOUT_MS
    );
    if (!res.ok) {
      if (opts?.strict) throw new BalanceUnavailableError(`WhatsOnChain HTTP ${res.status}`);
      return [..._pendingChange];
    }
    const confirmed = (await res.json()) as UTXO[];

    // Deduplicate: pending change UTXOs take priority over WoC data
    // since they have sourceTransaction attached for 0-conf chaining.
    const pendingKeys = new Set(_pendingChange.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
    const deduped = confirmed.filter((u) => {
      const key = utxoKey(u.tx_hash, u.tx_pos);
      // Exclude UTXOs already in pending change (dedup) AND already spent (stale WoC data)
      return !pendingKeys.has(key) && !_spent.has(key);
    });

    // When a spent UTXO no longer appears in the WoC response, it has been
    // confirmed as spent — safe to remove from the blacklist.
    const wocKeys = new Set(confirmed.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
    for (const spentKey of _spent) {
      if (!wocKeys.has(spentKey)) {
        _spent.delete(spentKey);
      }
    }

    // Merge and sort largest first — ensures we pick the big UTXO over many tiny ones
    const all = [..._pendingChange, ...deduped];
    all.sort((a, b) => b.value - a.value);
    return all;
  } catch (e) {
    // Re-throw the strict signal AND any transport failure (timeout, DNS, bad
    // JSON) — all of them mean "we do not know the balance".
    if (opts?.strict) {
      throw e instanceof BalanceUnavailableError
        ? e
        : new BalanceUnavailableError(e instanceof Error ? e.message : "read failed");
    }
    return [..._pendingChange];
  }
}

/**
 * @param opts.strict Throw `BalanceUnavailableError` rather than returning 0
 * when the balance could not be READ. Default (unset) keeps the spend-safe
 * behaviour: an unreadable wallet looks empty, so callers refuse to spend.
 */
export async function getBalance(opts?: { strict?: boolean }): Promise<number> {
  const utxos = await getUtxos(undefined, opts);
  return utxos
    .filter((u) => !_reserved.has(utxoKey(u.tx_hash, u.tx_pos)))
    .reduce((sum, u) => sum + u.value, 0);
}

/**
 * Reserve UTXOs that cover at least `neededSats`.
 * Returns reserved UTXOs or null if insufficient funds.
 */
async function reserveUtxos(neededSats: number): Promise<UTXO[] | null> {
  const utxos = await getUtxos(neededSats);
  const selected: UTXO[] = [];
  let total = 0;

  for (const utxo of utxos) {
    const key = utxoKey(utxo.tx_hash, utxo.tx_pos);
    if (_reserved.has(key)) continue;

    _reserved.add(key);
    selected.push(utxo);
    total += utxo.value;

    if (total >= neededSats) return selected;
  }

  // Not enough — release what we selected
  for (const utxo of selected) {
    _reserved.delete(utxoKey(utxo.tx_hash, utxo.tx_pos));
  }
  return null;
}

function releaseUtxos(utxos: UTXO[]): void {
  for (const utxo of utxos) {
    _reserved.delete(utxoKey(utxo.tx_hash, utxo.tx_pos));
  }
}

/**
 * Fetch source transaction hex for signing (if not already available from 0-conf chain).
 */
async function getSourceTransaction(utxo: UTXO): Promise<Transaction | null> {
  if (utxo.sourceTransaction) return utxo.sourceTransaction;

  try {
    const res = await fetchWithTimeout(
      `https://api.whatsonchain.com/v1/bsv/main/tx/${utxo.tx_hash}/hex`,
      READ_TIMEOUT_MS
    );
    if (!res.ok) {
      console.error(`OpenBook wallet: WoC /tx/hex returned ${res.status} for ${utxo.tx_hash}`);
      return null;
    }
    const hex = await res.text();
    return Transaction.fromHex(hex);
  } catch (e) {
    console.error(`OpenBook wallet: getSourceTransaction failed for ${utxo.tx_hash}`, e);
    return null;
  }
}

// ── Build & Broadcast ───────────────────────────────────────

/**
 * Build, sign, and broadcast a transaction with the given outputs.
 * Supports multi-UTXO inputs and 0-conf chaining.
 * Uses a mutex to prevent concurrent calls from grabbing the same UTXOs.
 */
export async function buildAndBroadcast(
  outputs: Array<{ lockingScript: LockingScript; satoshis: number }>
): Promise<BroadcastResult> {
  // Kill-switch backstop (Build C). Free boots are already routed to paid
  // pre-consume in executeBoot; this also stops post-logging and any other server
  // spend that reaches the wallet directly.
  if (isServerSpendDisabled()) {
    console.warn(
      "OpenBooks wallet: spending DISABLED (BSV_WALLET_SPEND_DISABLED) — refusing to broadcast"
    );
    return { status: "spend_disabled" };
  }

  const key = getServerKey();
  if (!key) {
    console.error("OpenBook wallet: no BSV_SERVER_WIF configured");
    return { status: "no_wallet" };
  }

  // Acquire the mutex — only one transaction builds at a time
  const release = await acquireTxMutex();

  try {
    return await _buildAndBroadcastInner(key, outputs);
  } finally {
    release();
  }
}

/**
 * Internal implementation — caller must hold the mutex.
 */
async function _buildAndBroadcastInner(
  key: PrivateKey,
  outputs: Array<{ lockingScript: LockingScript; satoshis: number }>,
  retryCount = 0
): Promise<BroadcastResult> {
  const totalNeeded = outputs.reduce((sum, o) => sum + o.satoshis, 0) + SERVER_FEE_BUFFER_SATS;
  const utxos = await reserveUtxos(totalNeeded);

  if (!utxos) {
    console.error("OpenBook wallet: insufficient funds or no UTXOs available");
    return { status: "insufficient_funds" };
  }

  try {
    const tx = new Transaction();

    // Add all reserved UTXOs as inputs
    for (const utxo of utxos) {
      const sourceTx = await getSourceTransaction(utxo);
      if (!sourceTx) {
        console.error(`OpenBook wallet: failed to fetch source tx ${utxo.tx_hash}`);
        releaseUtxos(utxos);
        return { status: "broadcast_failed", error: "Failed to fetch source transaction" };
      }

      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: utxo.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      });
    }

    // Add requested outputs
    for (const output of outputs) {
      tx.addOutput(output);
    }

    // Change output back to server — track its index for 0-conf chaining
    const changeOutputIndex = tx.outputs.length; // will be at this index after addOutput
    tx.addOutput({
      lockingScript: new P2PKH().lock(key.toPublicKey().toAddress()),
      change: true,
    });

    // Explicit 110 sat/kB fee. The ARC miner floor is 100 sat/kB, but tx.fee()
    // sizes the fee on the PRE-signing tx while DER signature length varies
    // (71 vs 72 bytes), so a fee computed at exactly 100 can land 1 sat under the
    // floor after signing → ARC error 465 (hit ~11% of genesis-seed batches at
    // 100; 0 rejections at 110). The extra 10% is rounding headroom.
    await tx.fee(new SatoshisPerKilobyte(110));
    await tx.sign();

    // If the fee consumed all remaining funds the change output will have 0 satoshis.
    // A 0-sat output is non-standard on BSV — remove it to avoid broadcast rejection.
    let hasChangeOutput = true;
    const changeOutputAfterFee = tx.outputs[changeOutputIndex];
    if (!changeOutputAfterFee?.satoshis || changeOutputAfterFee.satoshis <= 0) {
      tx.outputs.splice(changeOutputIndex, 1);
      hasChangeOutput = false;
    }

    let broadcastResult: Awaited<ReturnType<typeof tx.broadcast>>;
    try {
      broadcastResult = await withTimeout(tx.broadcast(), BROADCAST_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof TimeoutError) {
        // A broadcast timeout is INDETERMINATE — ARC may have accepted the tx and
        // simply responded slowly. We must NEVER rebuild here: a fresh tx = a new
        // txid = the server DOUBLE-PAYS. Release the RESERVATION (do NOT blacklist
        // the inputs: WhatsOnChain reflects on-chain reality, the change output —
        // if the tx landed — resurfaces via WoC, and any rare stale-WoC reuse is
        // caught by the double-spend self-heal below). Return a distinct terminal
        // status; callers must not retry or refund. See DECISIONS.md "Free-boot
        // path consumes the grant BEFORE paying" + Phase 2 Build A.
        const txid = tx.id("hex") as string;
        releaseUtxos(utxos);
        console.error(
          `OpenBooks wallet: broadcast TIMEOUT (indeterminate) txid=${txid} — not rebuilding (tx may have landed)`
        );
        return { status: "broadcast_timeout" };
      }
      throw e; // non-timeout rejection → handled by the outer catch (broadcast_failed)
    }

    if (broadcastResult.status === "success") {
      const txid = tx.id("hex") as string;

      // Remove the spent UTXOs from pending change and blacklist them so
      // stale WoC responses don't resurrect them as available.
      const spentKeys = new Set(utxos.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
      for (const sk of spentKeys) {
        _spent.add(sk);
      }
      for (let i = _pendingChange.length - 1; i >= 0; i--) {
        const pendingKey = utxoKey(_pendingChange[i].tx_hash, _pendingChange[i].tx_pos);
        if (spentKeys.has(pendingKey)) {
          _pendingChange.splice(i, 1);
        }
      }

      // 0-conf chain: register change output as immediately spendable
      if (hasChangeOutput) {
        const changeSats = tx.outputs[changeOutputIndex].satoshis;
        if (changeSats && changeSats > 0) {
          _pendingChange.push({
            tx_hash: txid,
            tx_pos: changeOutputIndex,
            value: changeSats,
            sourceTransaction: tx, // Keep the tx object for signing
          });

          // Cap queues to avoid unbounded growth
          while (_pendingChange.length > 50) _pendingChange.shift();
          while (_spent.size > 200) {
            const first = _spent.values().next().value;
            if (first) _spent.delete(first);
          }
        }
      }

      // Release the spent UTXOs from reservation (they're consumed now)
      releaseUtxos(utxos);

      return { status: "success", txid };
    }

    // Self-heal on double-spend: blacklist the competing tx's inputs and retry (max 3 attempts)
    const dsResult = broadcastResult as { code?: string; more?: { competingTxs?: string[] } };
    if (
      dsResult.code === "DOUBLE_SPEND_ATTEMPTED" &&
      dsResult.more?.competingTxs?.length &&
      retryCount < 3
    ) {
      console.warn(
        `OpenBooks wallet: double-spend detected, blacklisting competing UTXOs and retrying (attempt ${retryCount + 1}/3)`
      );
      for (const competingTxid of dsResult.more.competingTxs) {
        try {
          const txRes = await fetchWithTimeout(
            `https://api.whatsonchain.com/v1/bsv/main/tx/${competingTxid}`,
            READ_TIMEOUT_MS
          );
          if (txRes.ok) {
            const txData = (await txRes.json()) as { vin?: Array<{ txid: string; vout: number }> };
            for (const input of txData.vin ?? []) {
              _spent.add(utxoKey(input.txid, input.vout));
            }
          }
        } catch {
          /* best effort */
        }
      }
      releaseUtxos(utxos);
      return _buildAndBroadcastInner(key, outputs, retryCount + 1);
    }

    releaseUtxos(utxos);
    console.error("OpenBook: broadcast failed", broadcastResult);
    return { status: "broadcast_failed", error: String(broadcastResult) };
  } catch (e) {
    releaseUtxos(utxos);
    console.error("OpenBook: transaction error", e);
    return { status: "broadcast_failed", error: e instanceof Error ? e.message : String(e) };
  }
}
