import { type Script, Transaction, Utils } from "@bsv/sdk";

/**
 * Verify that a buyer's transaction really paid the seller.
 *
 * ⚠ THE TXID IS DERIVED, NEVER ACCEPTED — `txid = hash(rawTx)`, the same rule
 * `paid-post.ts` follows. There is no claimed txid to disagree with the bytes,
 * so substitution is impossible rather than merely checked for.
 *
 * ⚠ A FLOOR, NOT AN EXACT AMOUNT. The buyer has already broadcast by the time we
 * see this; rejecting for overpayment would take their money and give them
 * nothing. The only question worth asking is whether the seller got AT LEAST
 * what they asked.
 *
 * ⚠ THIS DOES NOT PROVE THE TRANSACTION CONFIRMED, and nothing here pretends
 * otherwise. It proves the bytes pay the seller and that they hash to the txid
 * recorded against the fill. A buyer could in principle broadcast a
 * double-spend; the guard against that is the same one the boot path uses — the
 * txid is unique in `listing_fills`, so one broadcast buys one fill, and a
 * conflicting spend is visible on chain to the seller who was named in it.
 */

export type FillVerdict =
  | { ok: true; txid: string; paidSats: number }
  | { ok: false; reason: FillFailure };

export type FillFailure = "malformed_tx" | "seller_underpaid";

function addressOf(script: Script): string | null {
  try {
    const asm = script.toASM().split(" ");
    const i = asm.indexOf("OP_HASH160");
    if (i === -1 || !asm[i + 1]) return null;
    return Utils.toBase58Check(Utils.toArray(asm[i + 1], "hex"));
  } catch {
    return null;
  }
}

export function verifyFillPayment(args: {
  rawTx: string;
  sellerAddress: string;
  /** Units × price. The least the seller may receive. */
  minSats: number;
}): FillVerdict {
  let tx: Transaction;
  let txid: string;
  try {
    tx = Transaction.fromHex(args.rawTx);
    txid = tx.id("hex");
  } catch {
    return { ok: false, reason: "malformed_tx" };
  }
  if (!/^[a-f0-9]{64}$/.test(txid)) return { ok: false, reason: "malformed_tx" };

  let paid = 0;
  for (const o of tx.outputs) {
    if (!o.lockingScript || !o.satoshis) continue;
    if (addressOf(o.lockingScript as Script) === args.sellerAddress) paid += o.satoshis;
  }
  if (paid < args.minSats) return { ok: false, reason: "seller_underpaid" };

  return { ok: true, txid, paidSats: paid };
}
