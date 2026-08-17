import { currentFeeRateSatsPerKb, FEE_RATE_SATS_PER_KB } from "@/lib/post-economics";
import {
  acquireTxMutex,
  type ClientUtxo,
  fetchSourceTxHex,
  fetchUtxos,
  getBsvSdk,
  recordBroadcast,
} from "./client-boot";

/**
 * Pay one address, from the user's own wallet, with no custody.
 *
 * ⚠ THE WALLET STATE IS IMPORTED, NOT REDECLARED — the same rule
 * `client-post.ts` follows. Posts, boosts and market payments all spend the SAME
 * UTXOs, so the mutex, the spent-blacklist and the 0-conf change queue must come
 * from one place. A second copy would hand out the same UTXO twice, and the
 * second transaction would simply vanish.
 *
 * Deliberately dumb: one payee, one change output, no inscription and no
 * platform fee. A market payment is a payment — everything that makes it a
 * PURCHASE (which listing, how many units, who claims it) is signed separately
 * and verified server-side against these bytes.
 */

export type ClientPayResult =
  | { status: "success"; txid: string; rawTx: string }
  | { status: "insufficient_funds"; needed: number; balance: number }
  | { status: "no_utxos" }
  | { status: "broadcast_failed"; error: string };

function estimateFee(inputCount: number, outputCount: number, rate: number): number {
  const bytes = 10 + 148 * inputCount + 34 * outputCount;
  return Math.max(100, Math.ceil((bytes * rate) / 1000));
}

const MAX_INPUTS = 20;

function selectUtxos(
  utxos: ClientUtxo[],
  target: number,
  rate: number
): { selected: ClientUtxo[]; total: number; fee: number } | null {
  // Smallest first, so a wallet full of dust gets swept rather than accumulating
  // crumbs nobody can ever spend.
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const selected: ClientUtxo[] = [];
  let total = 0;
  for (const u of sorted) {
    if (selected.length >= MAX_INPUTS) break;
    selected.push(u);
    total += u.value;
    if (total >= target + estimateFee(selected.length, 2, rate)) break;
  }
  const fee = estimateFee(selected.length, 2, rate);
  return total >= target + fee ? { selected, total, fee } : null;
}

export async function clientSidePay(
  wif: string,
  userAddress: string,
  payee: { address: string; satoshis: number }
): Promise<ClientPayResult> {
  const release = await acquireTxMutex();
  try {
    const { PrivateKey, P2PKH, Transaction, ARC } = await getBsvSdk();
    const key = PrivateKey.fromWif(wif);
    const rate = await currentFeeRateSatsPerKb().catch(() => FEE_RATE_SATS_PER_KB);

    const utxos = await fetchUtxos(userAddress, payee.satoshis + estimateFee(1, 2, rate));
    if (!utxos.length) return { status: "no_utxos" };

    const selection = selectUtxos(utxos, payee.satoshis, rate);
    if (!selection) {
      return {
        status: "insufficient_funds",
        needed: payee.satoshis + estimateFee(1, 2, rate),
        balance: utxos.reduce((n, u) => n + u.value, 0),
      };
    }

    const tx = new Transaction();
    for (const u of selection.selected) {
      const sourceTransaction =
        u.sourceTransaction ?? Transaction.fromHex(await fetchSourceTxHex(u.tx_hash));
      tx.addInput({
        sourceTransaction,
        sourceOutputIndex: u.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      });
    }

    tx.addOutput({
      lockingScript: new P2PKH().lock(payee.address),
      satoshis: payee.satoshis,
    });

    const changeSats = selection.total - payee.satoshis - selection.fee;
    // Below the economic floor an output costs more to spend than it holds, so
    // it goes to the miner rather than becoming a UTXO nobody can claim.
    const hasChange = changeSats >= 10;
    const changeIndex = hasChange ? tx.outputs.length : null;
    if (hasChange) {
      tx.addOutput({ lockingScript: new P2PKH().lock(userAddress), satoshis: changeSats });
    }

    await tx.sign();
    const txid = tx.id("hex");

    try {
      // ⚠ RE-BROADCASTING THE SAME BYTES IS SAFE; REBUILDING IS NOT. The
      // transaction is already signed, so a retry sends an identical payload
      // with an identical txid — if the first attempt landed, the second is a
      // no-op rather than a second payment.
      const result = await tx.broadcast(new ARC("https://arc.gorillapool.io"));
      if (result.status === "error") {
        return { status: "broadcast_failed", error: result.description ?? "broadcast rejected" };
      }
    } catch (e) {
      // Inputs are NOT blacklisted on failure — the next attempt should be free
      // to reuse them, exactly as the boot and post paths do.
      return {
        status: "broadcast_failed",
        error: e instanceof Error ? e.message : "broadcast failed",
      };
    }

    recordBroadcast({
      spent: selection.selected,
      txid,
      changeIndex,
      changeSats: hasChange ? changeSats : null,
      tx,
    });

    return { status: "success", txid, rawTx: tx.toHex() };
  } finally {
    release();
  }
}
