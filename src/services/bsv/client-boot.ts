/**
 * Client-side trustless boot transaction builder for OpenBooks.
 *
 * Runs entirely in the BROWSER. The user's browser builds a multi-output
 * split transaction, signs it with their private key, and broadcasts
 * directly to the BSV network via ARC. Zero server custody.
 *
 * Flow:
 * 1. Receive contributor shares (fetched by caller from /api/boot-shares)
 * 2. Fetch user's UTXOs from WhatsOnChain
 * 3. Fetch source transaction hex for each UTXO from WhatsOnChain
 * 4. Build multi-output tx: one P2PKH per contributor + OP_RETURN metadata + change
 * 5. Sign with user's private key
 * 6. Broadcast via tx.broadcast() (SDK built-in ARC broadcaster)
 * 7. Return txid for caller to confirm with server
 *
 * Double-spend prevention:
 * - Promise-based mutex — only one clientSideBoot executes at a time
 * - Spent-set — tracks consumed UTXOs so stale WoC data is filtered out
 * - 0-conf chaining — change output from the last tx is immediately available
 *   as an input for the next, skipping the WoC fetch entirely when sufficient
 */

import { bootAuditPayload } from "@/lib/boot-audit";
import { INSCRIPTION_SATS } from "./inscription";

// ── Types ───────────────────────────────────────────────────

export interface BootShare {
  address: string;
  sats: number;
  type: string; // 'pool_share' | 'boost_bonus' | 'platform'
}

export interface ClientBootResult {
  status: "success" | "insufficient_funds" | "needs_consolidation" | "broadcast_failed" | "error";
  txid?: string;
  rawTx?: string;
  error?: string;
  balance?: number;
  /** On `insufficient_funds`: the network fee a boot tx needs ON TOP of the
   * boot price. The deposit/top-up surface adds this to the price so "you have
   * enough" can't disagree with the builder. Purely a report of the fee the
   * selector already computed — does not affect selection, signing, or broadcast. */
  estimatedFee?: number;
}

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  /** Block height — 0 for unconfirmed mempool UTXOs, > 0 for confirmed */
  height: number;
}

/** Extended UTXO with optional sourceTransaction for 0-conf chaining.
 * Pending change entries leave `height` undefined since they're not yet indexed. */
export interface ClientUtxo extends Omit<WocUtxo, "height"> {
  height?: number;
  sourceTransaction?: import("@bsv/sdk").Transaction;
}

// ── SDK loader (same pattern as identity.ts) ────────────────

let _bsvSdkPromise: Promise<typeof import("@bsv/sdk")> | null = null;

export function getBsvSdk(): Promise<typeof import("@bsv/sdk")> {
  if (!_bsvSdkPromise) {
    _bsvSdkPromise = import("@bsv/sdk");
  }
  return _bsvSdkPromise;
}

// ── Transaction Mutex ──────────────────────────────────────
// Only one clientSideBoot call executes at a time. Others queue.
// Same promise-chain pattern as the server wallet mutex.

let _txMutexChain: Promise<void> = Promise.resolve();

export function acquireTxMutex(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ticket = _txMutexChain.then(() => {});
  _txMutexChain = _txMutexChain.then(() => gate);
  return ticket.then(() => release);
}

// ── Spent tracking & 0-conf chaining ───────────────────────

/** UTXOs consumed as inputs — blacklist for stale WoC data.
 *  Persisted to localStorage so it survives page refreshes. */
const SPENT_STORAGE_KEY = "openbook_spent_utxos";

function loadSpentSet(): Set<string> {
  try {
    const stored = localStorage.getItem(SPENT_STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSpentSet(spent: Set<string>): void {
  try {
    // Keep only the most recent entries to avoid unbounded growth
    const arr = Array.from(spent);
    const trimmed = arr.length > 500 ? arr.slice(-500) : arr;
    localStorage.setItem(SPENT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* localStorage unavailable — silent fail */
  }
}

const _spent = loadSpentSet();

/** Change outputs from recent broadcasts, immediately spendable */
const _pendingChange: ClientUtxo[] = [];

export function utxoKey(txHash: string, txPos: number): string {
  return `${txHash}:${txPos}`;
}

// ── WhatsOnChain helpers ────────────────────────────────────

/**
 * Whether a UTXO may be spent as ordinary money.
 *
 * ⚠ A 1-SATOSHI OUTPUT IS AN ORDINAL, NOT CHANGE. Under paid posting every post
 * mints its author an inscription locked to their own address at exactly
 * `INSCRIPTION_SATS` — the post-token this board exists to give people. It then
 * sits in the same wallet as their spending money, and `selectUtxos` sorts
 * SMALLEST-FIRST *deliberately*, to sweep up dust. So the author's own tokens
 * were the first inputs chosen for the next boost or paid post, and would be
 * burned as fee: "own what you post", with the wallet quietly eating the posts.
 *
 * Pure and exported so the rule is testable — the module around it does network
 * I/O and holds process-wide wallet state, and this is not a rule to verify by
 * reading it.
 */
export function isSpendableUtxo(value: number): boolean {
  return value > INSCRIPTION_SATS;
}

/**
 * Resolve an in-app API path for whichever runtime is calling.
 *
 * ⚠ A RELATIVE URL IS NOT PORTABLE. These builders were written for the browser,
 * where `/api/unspent` resolves against the page. Node has no base URL, so the
 * same call throws — which is what stood between this money path and the agent
 * runtime, since an autonomous agent builds and funds its own posts on the
 * server. Making the URL absolute there is the entire change: the alternative
 * was a second server-side transaction builder, and a forked money path is
 * exactly the mistake that left NymModal unable to pay.
 *
 * `site-origin` is imported lazily so nothing server-only is pulled into the
 * client bundle.
 */
async function apiUrl(path: string): Promise<string> {
  if (typeof window !== "undefined") return path;
  const { siteOrigin } = await import("@/lib/site-origin");
  return `${siteOrigin()}${path}`;
}

export async function fetchUtxos(address: string, neededSats?: number): Promise<ClientUtxo[]> {
  // If pending change covers our needs, skip the WoC fetch entirely
  if (neededSats !== undefined && _pendingChange.length > 0) {
    const pendingTotal = _pendingChange.reduce((sum, u) => sum + u.value, 0);
    if (pendingTotal >= neededSats) {
      return [..._pendingChange];
    }
  }

  const res = await fetch(await apiUrl(`/api/unspent?address=${address}&fresh=1`));
  if (!res.ok) {
    throw new Error(`UTXO fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // WoC returns null (not []) for addresses with no history at all
  if (!Array.isArray(data)) {
    return [..._pendingChange];
  }

  const wocUtxos = data as WocUtxo[];

  // Deduplicate: pending change UTXOs take priority (they have sourceTransaction).
  // Filter out spent UTXOs (blacklisted from prior successful broadcasts).
  // No height filtering — at 100 sat/kb (GorillaPool's minimum), all txs confirm
  // in the next block. Filtering unconfirmed UTXOs actively harms UX by hiding
  // valid recently-received funds.
  const pendingKeys = new Set(_pendingChange.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
  const filtered = wocUtxos.filter((u) => {
    const key = utxoKey(u.tx_hash, u.tx_pos);
    // ⚠ ORDINALS ARE NOT CHANGE. A 1-satoshi output on this address is an
    // inscription — a post-token, the thing this board exists to give people —
    // and `selectUtxos` sorts SMALLEST-FIRST on purpose, to sweep up dust. So
    // every ordinal the author owns was the first input picked for the next
    // boost or paid post, and would be spent as fee. "Own what you post", with
    // the wallet quietly eating the posts.
    //
    // Excluded here rather than in `selectUtxos` because this is the single
    // choke point both the boost and paid-post paths draw from — a second
    // filter is a second thing to forget.
    //
    // The 1-satoshi test is the same heuristic 1Sat wallets use, and it is
    // exact for anything this app mints (`INSCRIPTION_SATS`). Worst case it
    // strands a 1-sat change output, which costs ~15 sats to spend anyway.
    if (!isSpendableUtxo(u.value)) return false;
    return !pendingKeys.has(key) && !_spent.has(key);
  });

  // Clean up spent set: if WoC no longer returns a spent UTXO, it's confirmed spent
  const wocKeys = new Set(wocUtxos.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
  let spentChanged = false;
  for (const spentKey of _spent) {
    if (!wocKeys.has(spentKey)) {
      _spent.delete(spentKey);
      spentChanged = true;
    }
  }
  if (spentChanged) saveSpentSet(_spent);

  // Merge pending change + filtered WoC, sort largest first
  const all: ClientUtxo[] = [..._pendingChange, ...filtered];
  all.sort((a, b) => b.value - a.value);
  return all;
}

export async function fetchSourceTxHex(txHash: string): Promise<string> {
  // Proxy through our server to avoid CORS on WoC /tx/hex endpoint
  const res = await fetch(await apiUrl(`/api/tx-hex?txid=${txHash}`));
  if (!res.ok) {
    throw new Error(`Source tx fetch failed for ${txHash}: ${res.status}`);
  }
  return res.text();
}

// ── Validation ──────────────────────────────────────────────

function validateShares(shares: BootShare[], bootPriceSats: number): string | null {
  if (shares.length === 0) {
    return "No shares provided";
  }

  const totalDistributed = shares.reduce((sum, s) => sum + s.sats, 0);

  if (totalDistributed !== bootPriceSats) {
    return `Share total ${totalDistributed} does not match boot price ${bootPriceSats}`;
  }

  for (const share of shares) {
    if (share.sats <= 0) {
      return `Invalid sats value ${share.sats} for address ${share.address}`;
    }
    if (!share.address || share.address.length < 25) {
      return `Invalid address: ${share.address}`;
    }
  }

  return null;
}

// ── UTXO selection ──────────────────────────────────────────

/**
 * Maximum inputs per boot transaction.
 *
 * Each P2PKH input is ~148 bytes. At 0.1 sat/byte (100 sat/kb):
 *   20 inputs  = ~2,960 bytes = ~296 sats fee — easily covered by boot price
 *   50 inputs  = ~7,400 bytes = ~740 sats fee — within boot price floor
 *
 * Capping at 20 keeps the fee well under 1,500 sats on any realistic BSV fee rate.
 * Users with >20 UTXOs consolidate at a rate of ~20 per boot (change output merges them).
 * A user with 290 UTXOs is fully consolidated after ~15 boots.
 */
const MAX_CONSOLIDATION_INPUTS = 20;

/**
 * Estimate the fee for a transaction with N inputs and M outputs (P2PKH).
 * Byte formula: 10 (overhead) + 148 * inputs + 34 * outputs + 200 (OP_RETURN est.)
 * The OP_RETURN carries a JSON boot-audit record (~157 bytes); 200 leaves
 * margin. NOTE: this estimate only sizes UTXO selection — the actual fee is the
 * SDK's exact `tx.fee()` on the built tx, so the payload size can't underpay.
 * If a future field is added to the boot-audit record (see lib/boot-audit.ts)
 * and the payload grows past ~180 bytes, RAISE this 200 constant so selection
 * keeps its margin (otherwise a wallet right at the balance edge could select
 * one input too few and spuriously hit insufficient_funds).
 * Rate: 0.1 sat/byte (100 sat/kb) to match ARC's minimum policy.
 */
function estimateFee(inputCount: number, outputCount: number): number {
  const bytes = 10 + 148 * inputCount + 34 * outputCount + 200;
  return Math.max(100, Math.ceil(bytes * 0.1));
}

/**
 * Select UTXOs to cover the target amount, opportunistically consolidating extras.
 *
 * Strategy:
 * 1. Sort UTXOs smallest-first so tiny ones get swept up first.
 * 2. Fill up to MAX_CONSOLIDATION_INPUTS, re-calculating the fee budget each time.
 * 3. Stop early if we have enough value AND adding another input costs more in fee
 *    than the UTXO is worth (dust threshold).
 *
 * Effect: users with many tiny UTXOs consolidate ~20 per boot for free.
 * Users with a single large UTXO select just that one (unchanged behaviour).
 */
function selectUtxos(
  utxos: ClientUtxo[],
  bootPriceSats: number,
  outputCount: number
): { selected: ClientUtxo[]; total: number; estimatedFee: number } | null {
  if (utxos.length === 0) return null;

  // Separate large UTXOs (can cover boot alone) from tiny ones
  // Smallest-first so tiny UTXOs get consumed on each boot
  const sorted = [...utxos].sort((a, b) => a.value - b.value);

  const selected: ClientUtxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    if (selected.length >= MAX_CONSOLIDATION_INPUTS) break;

    selected.push(utxo);
    total += utxo.value;

    const fee = estimateFee(selected.length, outputCount);
    const needed = bootPriceSats + fee;

    // We have enough. Check if the next UTXO is worth including.
    // Include it only if it's worth more than the marginal fee cost of one extra input.
    if (total >= needed) {
      const nextUtxo = sorted[selected.length]; // next candidate (not yet selected)
      if (!nextUtxo) break; // no more UTXOs
      const marginalFee = estimateFee(selected.length + 1, outputCount) - fee;
      if (nextUtxo.value <= marginalFee) break; // dust — stop here
      // Otherwise keep going to consolidate it
    }
  }

  const fee = estimateFee(selected.length, outputCount);
  if (total >= bootPriceSats + fee) {
    return { selected, total, estimatedFee: fee };
  }

  return null; // Insufficient funds
}

/**
 * Post-broadcast UTXO bookkeeping, shared with the paid-post path.
 *
 * ⚠ THE WALLET STATE BELOW IS MODULE-LEVEL AND MUST STAY THAT WAY. Posts and
 * boosts spend the SAME UTXO set, so a second module with its own `_spent` /
 * `_pendingChange` / mutex would let the two paths hand out the same UTXO twice
 * — a double-spend, not a race we could tune away. ES modules are singletons, so
 * importing from here is what keeps one view of the wallet.
 *
 * ⚠ `clientSideBoot` still does this inline, and the two copies must stay in
 * step. Switching boot over is deliberately NOT done here: this file has no test
 * coverage, and rewriting an audited money path blind is worse than the
 * duplication. See ROADMAP "Refactor clientSideBoot".
 */
export function recordBroadcast(args: {
  spent: ClientUtxo[];
  txid: string;
  changeIndex: number | null;
  changeSats: number | null;
  tx: unknown;
}): void {
  const spentKeys = new Set(args.spent.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
  for (const sk of spentKeys) _spent.add(sk);

  for (let i = _pendingChange.length - 1; i >= 0; i--) {
    const key = utxoKey(_pendingChange[i].tx_hash, _pendingChange[i].tx_pos);
    if (spentKeys.has(key)) _pendingChange.splice(i, 1);
  }

  if (args.changeIndex !== null && args.changeSats && args.changeSats > 0) {
    _pendingChange.push({
      tx_hash: args.txid,
      tx_pos: args.changeIndex,
      value: args.changeSats,
      sourceTransaction: args.tx as ClientUtxo["sourceTransaction"],
    });
    while (_pendingChange.length > 50) _pendingChange.shift();
    while (_spent.size > 500) {
      const first = _spent.values().next().value;
      if (first) _spent.delete(first);
    }
  }

  saveSpentSet(_spent);
}

// ── Main entry point ────────────────────────────────────────

/**
 * Build, sign, and broadcast a boot transaction entirely in the browser.
 *
 * Uses a mutex to serialize calls — rapid clicks queue up instead of
 * racing for the same UTXOs. After each broadcast, the change output
 * is tracked for 0-conf chaining so the next boot can execute immediately.
 *
 * @param wif        - User's private key in WIF format
 * @param userAddress - User's BSV address (for change output)
 * @param postId     - The post being booted
 * @param shares     - Contributor payout shares (must sum to bootPriceSats)
 * @param bootPriceSats - Total boot price in satoshis
 * @param onStatus   - Optional callback for status updates ("sending" | "retrying")
 */
export async function clientSideBoot(
  wif: string,
  userAddress: string,
  postId: number,
  shares: BootShare[],
  bootPriceSats: number,
  onStatus?: (status: "sending" | "retrying") => void
): Promise<ClientBootResult> {
  // ── Validate inputs ─────────────────────────────────────
  const validationError = validateShares(shares, bootPriceSats);
  if (validationError) {
    return { status: "error", error: validationError };
  }

  // ── Acquire mutex — only one tx builds at a time ────────
  const release = await acquireTxMutex();

  try {
    return await _clientSideBootInner(wif, userAddress, postId, shares, bootPriceSats, onStatus);
  } finally {
    release();
  }
}

/**
 * Internal implementation — caller must hold the mutex.
 */
async function _clientSideBootInner(
  wif: string,
  userAddress: string,
  postId: number,
  shares: BootShare[],
  bootPriceSats: number,
  onStatus?: (status: "sending" | "retrying") => void
): Promise<ClientBootResult> {
  try {
    const { Transaction, PrivateKey, P2PKH, Script, OP, SatoshisPerKilobyte } = await getBsvSdk();

    // ── Parse private key ───────────────────────────────────
    let privateKey: InstanceType<typeof PrivateKey>;
    try {
      privateKey = PrivateKey.fromWif(wif);
    } catch {
      return { status: "error", error: "Invalid private key" };
    }

    onStatus?.("sending");

    // ── Fetch UTXOs (with spent-filtering + pending change) ─
    // Use a conservative worst-case estimate for the pending-change shortcut check:
    // MAX_CONSOLIDATION_INPUTS inputs, shares.length + 2 outputs (payouts + OP_RETURN + change)
    const outputCount = shares.length + 2; // contributor outputs + OP_RETURN + change
    const worstCaseFee = estimateFee(MAX_CONSOLIDATION_INPUTS, outputCount);
    const totalNeeded = bootPriceSats + worstCaseFee;

    const utxos = await fetchUtxos(userAddress, totalNeeded);

    if (utxos.length === 0) {
      console.warn(
        "[clientSideBoot] No UTXOs found for address:",
        userAddress,
        "— address may have no confirmed/unconfirmed outputs"
      );
      return {
        status: "insufficient_funds",
        balance: 0,
        estimatedFee: estimateFee(1, outputCount),
      };
    }

    const balance = utxos.reduce((sum, u) => sum + u.value, 0);

    // ── Select UTXOs (with opportunistic consolidation) ─────
    // Grabs up to MAX_CONSOLIDATION_INPUTS tiny UTXOs on every boot.
    // Users with fragmented wallets consolidate ~20 UTXOs per boot for free.
    const selection = selectUtxos(utxos, bootPriceSats, outputCount);
    if (!selection) {
      // Check if total balance COULD cover boot after consolidation
      // (wallet is too fragmented, not actually broke)
      const minBootFee = estimateFee(1, outputCount); // 1 consolidated input
      if (balance >= bootPriceSats + minBootFee) {
        console.log(
          `[clientSideBoot] Wallet fragmented: balance=${balance} sats across ${utxos.length} UTXOs — needs consolidation`
        );
        return { status: "needs_consolidation", balance };
      }
      console.warn(
        `[clientSideBoot] Insufficient funds: balance=${balance} sats, needed=${bootPriceSats + worstCaseFee} sats, address=${userAddress}`
      );
      // minBootFee is the threshold this branch tests against (balance <
      // bootPriceSats + minBootFee), so reporting it makes the top-up shortfall
      // exact and always positive here.
      return { status: "insufficient_funds", balance, estimatedFee: minBootFee };
    }
    // ── Fetch source transactions (batched to avoid WoC rate limits) ──
    // For 0-conf chained UTXOs, sourceTransaction is already attached — skip the fetch.
    // Batch in groups of 5 with 1s delay to stay under WoC's ~3 req/s limit.
    // The server-side tx-hex proxy caches results, so repeated txids are instant.
    const SOURCE_BATCH = 5;
    const sourceTxs: Array<{ utxo: ClientUtxo; sourceTx: InstanceType<typeof Transaction> }> = [];
    try {
      for (let i = 0; i < selection.selected.length; i += SOURCE_BATCH) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        const batch = selection.selected.slice(i, i + SOURCE_BATCH);
        const results = await Promise.all(
          batch.map(async (utxo) => {
            if (utxo.sourceTransaction) {
              return { utxo, sourceTx: utxo.sourceTransaction };
            }
            const hex = await fetchSourceTxHex(utxo.tx_hash);
            return { utxo, sourceTx: Transaction.fromHex(hex) };
          })
        );
        sourceTxs.push(...results);
      }
    } catch (e) {
      return {
        status: "broadcast_failed",
        error: `Failed to fetch source transactions: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // ── Build transaction ───────────────────────────────────
    const tx = new Transaction();

    // Add inputs
    for (const { utxo, sourceTx } of sourceTxs) {
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: utxo.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(privateKey),
      });
    }

    // Add contributor payout outputs
    for (const share of shares) {
      tx.addOutput({
        lockingScript: new P2PKH().lock(share.address),
        satoshis: share.sats,
      });
    }

    // Add OP_RETURN metadata output
    const opReturnScript = new Script();
    opReturnScript.writeOpCode(OP.OP_FALSE);
    opReturnScript.writeOpCode(OP.OP_RETURN);

    // Shared on-chain boot audit record — same shape as the server-funded path
    // (see src/lib/boot-audit.ts). funded:"booter" = this is a client-paid boot.
    const auditPayload = bootAuditPayload({
      postId,
      booter: userAddress,
      funded: "booter",
      total: bootPriceSats,
    });
    opReturnScript.writeBin(Array.from(new TextEncoder().encode(auditPayload)));

    tx.addOutput({
      lockingScript: opReturnScript as import("@bsv/sdk").LockingScript,
      satoshis: 0,
    });

    // Change output back to user — track its index for 0-conf chaining
    const changeOutputIndex = tx.outputs.length;
    tx.addOutput({
      lockingScript: new P2PKH().lock(userAddress),
      change: true,
    });

    // ── Fee calculation and signing ─────────────────────────
    // 110 sat/kb. ARC floor is 100, but tx.fee() sizes the fee pre-signing while
    // DER signature length varies (71/72 bytes), so 100 can land 1 sat under the
    // floor after signing → ARC error 465. 110 adds rounding headroom (verified
    // during genesis seeding: 0 rejections at 110 vs ~11% at 100).
    await tx.fee(new SatoshisPerKilobyte(110));
    await tx.sign();

    // If the fee consumed all remaining funds the change output will have 0 sats.
    // A 0-sat output is non-standard on BSV — remove it to avoid broadcast rejection.
    let hasChangeOutput = true;
    const changeOutputAfterFee = tx.outputs[changeOutputIndex];
    if (!changeOutputAfterFee?.satoshis || changeOutputAfterFee.satoshis <= 0) {
      tx.outputs.splice(changeOutputIndex, 1);
      hasChangeOutput = false;
    }

    // ── Broadcast (with retry for 0-conf chain propagation) ──
    // No pre-broadcast blacklisting. Double-spend prevention is handled by:
    //   1. Mutex (acquireTxMutex) — only one boot executes at a time
    //   2. 0-conf chaining (_pendingChange) — next boot uses change directly
    //   3. Boot throttle (3s in BootContext) — UI prevents rapid re-clicks
    // Pre-broadcast blacklisting was removed because it caused permanent wallet
    // lockout: failed broadcasts left inputs in localStorage _spent with no
    // automatic recovery path. The user had to manually clear localStorage.
    let broadcastResult: Awaited<ReturnType<typeof tx.broadcast>>;
    try {
      broadcastResult = await tx.broadcast();
      let retries = 0;
      while (
        retries < 3 &&
        broadcastResult.status !== "success" &&
        "description" in broadcastResult &&
        ((broadcastResult as { description?: string }).description
          ?.toUpperCase()
          .includes("ORPHAN") ||
          (broadcastResult as { code?: string }).code?.toUpperCase().includes("ORPHAN"))
      ) {
        retries++;
        console.log(`[clientSideBoot] Parent in orphan mempool — retry ${retries}/3 in 1.5s`);
        onStatus?.("retrying");
        await new Promise((r) => setTimeout(r, 1500));
        broadcastResult = await tx.broadcast();
      }
    } catch (networkError) {
      return {
        status: "broadcast_failed",
        error: `Network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
      };
    }

    // Detect "txn-already-known" (code 257): our exact tx is already in the
    // mempool from a prior submission. Deterministic signing means the txid
    // matches, so this is OUR tx — treat as success. Exclude "conflict" (258)
    // which means a DIFFERENT tx spent our inputs first.
    //
    // Match on the structured code field, NOT substring of the raw payload.
    // A previous `desc.includes("257")` falsely matched "257" in timestamps,
    // txid hex, byte offsets, fee amounts, port numbers — classifying failed
    // broadcasts as success and poisoning _spent with unspent UTXOs.
    const result = broadcastResult as {
      status?: string | number;
      code?: string | number;
      description?: string;
    };
    const code = String(result.code ?? "").trim();
    const desc = (result.description ?? "").toLowerCase();
    const alreadyKnown =
      broadcastResult.status !== "success" &&
      code !== "258" &&
      !desc.includes("conflict") &&
      (code === "257" ||
        /\balready[- ]known\b/.test(desc) ||
        desc.includes("already in the mempool"));

    if (broadcastResult.status === "success" || alreadyKnown) {
      const txid = tx.id("hex") as string;
      if (alreadyKnown) {
        console.log(`[clientSideBoot] Already in mempool (idempotent success): ${txid}`);
      }

      // ── Track spent UTXOs (success-only blacklist) ───────────
      const spentKeys = new Set(selection.selected.map((u) => utxoKey(u.tx_hash, u.tx_pos)));
      for (const sk of spentKeys) {
        _spent.add(sk);
      }
      // Remove consumed UTXOs from pending change
      for (let i = _pendingChange.length - 1; i >= 0; i--) {
        const pendingKey = utxoKey(_pendingChange[i].tx_hash, _pendingChange[i].tx_pos);
        if (spentKeys.has(pendingKey)) {
          _pendingChange.splice(i, 1);
        }
      }

      // ── 0-conf chain: register change as immediately spendable ─
      if (hasChangeOutput) {
        const changeSats = tx.outputs[changeOutputIndex].satoshis;
        if (changeSats && changeSats > 0) {
          _pendingChange.push({
            tx_hash: txid,
            tx_pos: changeOutputIndex,
            value: changeSats,
            sourceTransaction: tx,
          });

          // Cap queues to avoid unbounded growth
          while (_pendingChange.length > 50) _pendingChange.shift();
          while (_spent.size > 500) {
            const first = _spent.values().next().value;
            if (first) _spent.delete(first);
          }
        }
      }

      saveSpentSet(_spent);
      return { status: "success", txid, rawTx: tx.toHex() };
    }

    // Broadcast failed — do NOT blacklist inputs. Next boot retries same
    // inputs: gets "already-known" (handled above) or builds fresh.
    return {
      status: "broadcast_failed",
      error:
        typeof broadcastResult === "object"
          ? JSON.stringify(broadcastResult)
          : String(broadcastResult),
    };
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── UTXO Consolidation ─────────────────────────────────────────

/** Minimum UTXO value worth including in consolidation.
 * At 100 sat/kb, each P2PKH input costs ~15 sats. Set to 16 so any UTXO
 * that covers its own inclusion fee gets swept. */
const DUST_THRESHOLD = 16;

/**
 * Consolidate all UTXOs into a single output.
 * Uses ARC (SDK default) at 100 sat/kb — consistent with all other tx paths.
 * Consolidation is not time-sensitive so a lower fee rate is safe.
 *
 * Called automatically when clientSideBoot returns 'needs_consolidation'.
 * The user sees "Preparing..." while this runs.
 *
 * @param onStatus - Optional callback; called with "preparing" when consolidation starts
 */
export async function consolidateUtxos(
  wif: string,
  userAddress: string,
  onStatus?: (status: "preparing") => void
): Promise<ClientBootResult> {
  const release = await acquireTxMutex();

  try {
    const { Transaction, PrivateKey, P2PKH, SatoshisPerKilobyte } = await getBsvSdk();

    let privateKey: InstanceType<typeof PrivateKey>;
    try {
      privateKey = PrivateKey.fromWif(wif);
    } catch {
      return { status: "error", error: "Invalid private key" };
    }

    onStatus?.("preparing");

    const utxos = await fetchUtxos(userAddress);

    if (utxos.length <= 1) {
      return { status: "success", txid: "" }; // nothing to consolidate
    }

    // Filter by dust threshold only. No height filtering — at 100 sat/kb
    // (GorillaPool's minimum), all txs confirm in the next block.
    // Safety cap at 200 inputs to prevent pathologically large transactions.
    const MAX_CONSOLIDATION_SWEEP = 200;
    const spendable = utxos
      .filter((u) => u.value >= DUST_THRESHOLD)
      .slice(0, MAX_CONSOLIDATION_SWEEP);
    const dustDropped = utxos.length - spendable.length;
    if (dustDropped > 0) {
      console.log(
        `[consolidateUtxos] Excluded ${dustDropped} dust UTXOs (below ${DUST_THRESHOLD} sats) from sweep`
      );
    }
    if (spendable.length <= 1) {
      return { status: "success", txid: "" };
    }

    const total = spendable.reduce((sum, u) => sum + u.value, 0);
    console.log(
      `[consolidateUtxos] Sweeping ${spendable.length} UTXOs (${total} sats) for ${userAddress}`
    );

    const tx = new Transaction();

    // Fetch source transactions in small batches to respect WoC rate limits (~3 req/s).
    // Inter-batch delay prevents 429s when sweeping many UTXOs.
    const BATCH_SIZE = 5;
    const sourceTxs: Array<{ utxo: ClientUtxo; sourceTx: InstanceType<typeof Transaction> }> = [];
    try {
      for (let i = 0; i < spendable.length; i += BATCH_SIZE) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        const batch = spendable.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (utxo) => {
            if (utxo.sourceTransaction) return { utxo, sourceTx: utxo.sourceTransaction };
            const hex = await fetchSourceTxHex(utxo.tx_hash);
            return { utxo, sourceTx: Transaction.fromHex(hex) };
          })
        );
        sourceTxs.push(...results);
      }
    } catch (e) {
      return {
        status: "broadcast_failed",
        error: `Failed to fetch source transactions: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    for (const { utxo, sourceTx } of sourceTxs) {
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: utxo.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(privateKey),
      });
    }

    // Single change output back to self
    tx.addOutput({
      lockingScript: new P2PKH().lock(userAddress),
      change: true,
    });

    // 110 sat/kb — uniform rate across all tx paths (ARC floor is 100; the extra
    // 10 absorbs pre-signing fee-rounding vs variable DER sig length → avoids the
    // 1-sat ARC error-465 rejection).
    await tx.fee(new SatoshisPerKilobyte(110));
    await tx.sign();

    // NOTE: No optimistic blacklisting for consolidation. Unlike clientSideBoot
    // (1-5 inputs, all critical), consolidation sweeps many UTXOs (potentially 100+).
    // If some conflict due to prior pending txs, blacklisting ALL would lock the
    // entire wallet. Only blacklist on success — on failure, user retries once
    // conflicting txs confirm and WoC stops returning them.

    // ARC (SDK default) at 110 sat/kb — consistent with all other broadcast paths.
    // Previously used WoC due to a local DNS issue misattributed to ARC.
    let broadcastResult: Awaited<ReturnType<typeof tx.broadcast>>;
    try {
      broadcastResult = await tx.broadcast();
    } catch (networkError) {
      return {
        status: "broadcast_failed",
        error: `Network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
      };
    }

    // Detect "txn-already-known" (code 257) — our exact tx already in mempool
    // from a prior submission. Deterministic signing means matching txid = our tx.
    // Exclude "conflict" (258) which means a DIFFERENT tx spent our inputs.
    // Match on structured code field, not substring of raw payload.
    const result = broadcastResult as {
      status?: string | number;
      code?: string | number;
      description?: string;
    };
    const code = String(result.code ?? "").trim();
    const desc = (result.description ?? "").toLowerCase();
    const alreadyKnown =
      broadcastResult.status !== "success" &&
      code !== "258" &&
      !desc.includes("conflict") &&
      (code === "257" ||
        /\balready[- ]known\b/.test(desc) ||
        desc.includes("already in the mempool"));

    if (broadcastResult.status === "success" || alreadyKnown) {
      const txid = tx.id("hex") as string;
      if (alreadyKnown) {
        console.log(
          `[consolidateUtxos] Already in mempool (idempotent success): ${spendable.length} UTXOs → 1, txid=${txid}`
        );
      } else {
        console.log(`[consolidateUtxos] Success: ${spendable.length} UTXOs → 1, txid=${txid}`);
      }

      // Blacklist on success (or already-known) — tx is in the mempool
      for (const utxo of spendable) {
        _spent.add(utxoKey(utxo.tx_hash, utxo.tx_pos));
      }
      // Remove any pending change that was consumed
      for (let i = _pendingChange.length - 1; i >= 0; i--) {
        const key = utxoKey(_pendingChange[i].tx_hash, _pendingChange[i].tx_pos);
        if (_spent.has(key)) _pendingChange.splice(i, 1);
      }
      // Register consolidated output as pending change for 0-conf chaining
      const changeSats = tx.outputs[0]?.satoshis;
      if (changeSats && changeSats > 0) {
        _pendingChange.push({
          tx_hash: txid,
          tx_pos: 0,
          value: changeSats,
          sourceTransaction: tx,
        });
      }

      // Cap queues
      while (_pendingChange.length > 50) _pendingChange.shift();
      while (_spent.size > 500) {
        const first = _spent.values().next().value;
        if (first) _spent.delete(first);
      }

      saveSpentSet(_spent);
      return { status: "success", txid };
    }

    // Consolidation failed — do NOT blacklist inputs (would lock entire wallet).
    // User should wait for conflicting txs to confirm, then retry.
    console.error("[consolidateUtxos] Broadcast failed:", broadcastResult);

    return {
      status: "broadcast_failed",
      error:
        typeof broadcastResult === "object"
          ? JSON.stringify(broadcastResult)
          : String(broadcastResult),
    };
  } catch (e) {
    console.error("[consolidateUtxos] Error:", e);
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
  }
}
