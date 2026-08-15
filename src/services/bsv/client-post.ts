/**
 * Paid posting — the author funds and OWNS their own post.
 *
 * The browser builds one transaction that:
 *   1. inscribes the post's record on a **1-satoshi output locked to the
 *      author** — the token, ownable and transferable (see `inscription.ts`);
 *   2. pays the platform its markup (see `post-economics.ts`);
 *   3. returns change to the author.
 *
 * ⚠ NO CUSTODY, AND THE SHAPE IS THE ARGUMENT. Every satoshi leaves in the same
 * transaction it arrived in; we never hold a user's money, and the platform fee
 * is an ordinary output anyone can verify on-chain rather than a balance we
 * credit ourselves. This mirrors `clientSideBoot` deliberately — that path is
 * audited and this is the same trust model.
 *
 * ⚠ THE WALLET STATE IS IMPORTED, NOT REDECLARED. Posts and boosts spend the
 * SAME UTXOs, so the mutex, the spent-blacklist and the 0-conf change queue all
 * come from `client-boot.ts`. Giving this module its own copies would let the
 * two paths hand out the same UTXO twice.
 */

import {
  currentFeeRateSatsPerKb,
  FEE_RATE_SATS_PER_KB,
  type PostPrice,
} from "@/lib/post-economics";
import {
  acquireTxMutex,
  type ClientUtxo,
  fetchSourceTxHex,
  fetchUtxos,
  getBsvSdk,
  recordBroadcast,
  utxoKey,
} from "./client-boot";
import { buildInscriptionScript, INSCRIPTION_SATS } from "./inscription";

export type ClientPostResult =
  | {
      status: "success";
      txid: string;
      rawTx: string;
      /** Output index of the inscription — with the txid this is the token's ID. */
      vout: number;
    }
  | { status: "insufficient_funds"; needed: number; balance: number }
  | { status: "no_utxos" }
  | { status: "broadcast_failed"; error: string };

/** Same shape as the boot path's estimator, at whatever rate the quote used. */
function estimateFee(
  inputCount: number,
  outputCount: number,
  rate: number = FEE_RATE_SATS_PER_KB
): number {
  const bytes = 10 + 148 * inputCount + 34 * outputCount + 400; // +400 for the envelope
  return Math.max(100, Math.ceil((bytes * rate) / 1000));
}

const MAX_INPUTS = 20;

/**
 * Select UTXOs covering `target` plus fees. Smallest-first, so a wallet full of
 * dust gets swept up rather than accumulating unspendable crumbs.
 */
function selectUtxos(
  utxos: ClientUtxo[],
  target: number,
  outputCount: number,
  rate: number
): { selected: ClientUtxo[]; total: number; fee: number } | null {
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const selected: ClientUtxo[] = [];
  let total = 0;

  for (const u of sorted) {
    if (selected.length >= MAX_INPUTS) break;
    selected.push(u);
    total += u.value;
    if (total >= target + estimateFee(selected.length, outputCount, rate)) break;
  }

  const fee = estimateFee(selected.length, outputCount, rate);
  return total >= target + fee ? { selected, total, fee } : null;
}

/**
 * Build, sign and broadcast a paid post.
 *
 * @param wif             author's key
 * @param userAddress     author's address — owns the inscription AND takes change
 * @param payload         the on-chain record (JSON), inscribed verbatim
 * @param platformAddress where the markup goes; omit the output entirely at 0
 * @param price           quote from `postPrice`, so what we charge and what we
 *                        build agree — computing the fee twice from different
 *                        rates is how a quote and a transaction drift apart
 */
export async function clientSidePost(
  wif: string,
  userAddress: string,
  payload: string,
  platformAddress: string | null,
  price: PostPrice
): Promise<ClientPostResult> {
  const release = await acquireTxMutex();
  try {
    const { PrivateKey, P2PKH, Transaction, Utils, ARC } = await getBsvSdk();
    const key = PrivateKey.fromWif(wif);

    const wantsPlatformFee = price.platformFeeSats > 0 && !!platformAddress;
    // inscription + optional platform fee + change
    const outputCount = 2 + (wantsPlatformFee ? 1 : 0);
    const target = INSCRIPTION_SATS + (wantsPlatformFee ? price.platformFeeSats : 0);

    // ⚠ THE LIVE RATE, NOT A CONSTANT. A hardcoded fee is safe only while the
    // miner's published floor stays under it; the day it rises, every paid post
    // is rejected AFTER the author committed, and nothing in the code would say
    // why. Falls back to the constant on any failure, never below it.
    const rate = await currentFeeRateSatsPerKb();

    const utxos = await fetchUtxos(userAddress, target + estimateFee(1, outputCount, rate));
    if (!utxos.length) return { status: "no_utxos" };

    const selection = selectUtxos(utxos, target, outputCount, rate);
    if (!selection) {
      const balance = utxos.reduce((n, u) => n + u.value, 0);
      return {
        status: "insufficient_funds",
        needed: target + estimateFee(1, outputCount, rate),
        balance,
      };
    }

    const tx = new Transaction();

    for (const u of selection.selected) {
      // 0-conf chaining: a change output we just created carries its own source
      // transaction, so it can be spent before WhatsOnChain has indexed it.
      const sourceTransaction =
        u.sourceTransaction ?? Transaction.fromHex(await fetchSourceTxHex(u.tx_hash));
      tx.addInput({
        sourceTransaction,
        sourceOutputIndex: u.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      });
    }

    // ⚠ OUTPUT 0 IS THE INSCRIPTION, AND THE ORDER IS PART OF THE TOKEN'S ID.
    // The outpoint `<txid>_0` is what identifies this post forever, so the
    // inscription must not drift to another index.
    tx.addOutput({
      lockingScript: buildInscriptionScript({
        address: userAddress,
        contentType: "application/json",
        data: Utils.toArray(payload, "utf8"),
      }),
      satoshis: INSCRIPTION_SATS,
    });

    if (wantsPlatformFee && platformAddress) {
      tx.addOutput({
        lockingScript: new P2PKH().lock(platformAddress),
        satoshis: price.platformFeeSats,
      });
    }

    const changeSats = selection.total - target - selection.fee;
    // Below the economic floor there is no point creating an output nobody can
    // spend — leave it to the miner as fee instead of minting a dust UTXO.
    const hasChange = changeSats >= 10;
    const changeIndex = hasChange ? tx.outputs.length : null;
    if (hasChange) {
      tx.addOutput({ lockingScript: new P2PKH().lock(userAddress), satoshis: changeSats });
    }

    await tx.sign();

    const txid = tx.id("hex");
    try {
      const result = await tx.broadcast(new ARC("https://arc.gorillapool.io"));
      if (result.status === "error") {
        return { status: "broadcast_failed", error: result.description ?? "broadcast rejected" };
      }
    } catch (e) {
      // Do NOT blacklist inputs on failure — the next attempt should be free to
      // reuse them, exactly as the boot path does.
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

    return { status: "success", txid, rawTx: tx.toHex(), vout: 0 };
  } finally {
    release();
  }
}

/** Exported for tests — the selection and fee logic, without any network. */
export const __test = { estimateFee, selectUtxos, utxoKey };
