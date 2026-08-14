/**
 * Verify that a paid post's transaction actually does what it claims.
 *
 * Under paid posting the AUTHOR broadcasts, so the server never funds the
 * anchor — but that means the server is handed bytes by the person who benefits
 * from them. Everything below exists because of that.
 *
 * ⚠ THE TXID IS DERIVED, NEVER ACCEPTED. `txid = hash(rawTx)`, so recomputing it
 * here removes substitution entirely: there is no claimed txid to disagree with
 * the bytes. (`boot-confirm` takes a txid and binds it to the rawTx because its
 * caller already knows one; here there is no reason to accept one at all.)
 *
 * ⚠ THE INSCRIBED PAYLOAD IS COMPARED TO THE STORED CONTENT. Without this a user
 * could inscribe one thing and have us store another — the chain record and the
 * board would disagree, and the chain record is the one we tell people to trust.
 */

import { type Script, Transaction, Utils } from "@bsv/sdk";
import { parseInscription } from "@/services/bsv/inscription";

export type PaidPostVerdict =
  | { ok: true; txid: string; vout: number }
  | { ok: false; reason: PaidPostFailure };

export type PaidPostFailure =
  | "malformed_tx"
  | "no_inscription"
  | "content_mismatch"
  | "wrong_owner"
  | "platform_underpaid";

/** Output index the inscription must occupy. Fixed, because `<txid>_<vout>` is
 *  the token's permanent identity — a drifting index would rename the token. */
export const INSCRIPTION_VOUT = 0;

function addressOf(script: Script): string | null {
  try {
    // `toASM` on a P2PKH gives OP_DUP OP_HASH160 <pkh> …; the SDK exposes the
    // address form directly for standard locks.
    const asm = script.toASM().split(" ");
    const i = asm.indexOf("OP_HASH160");
    if (i === -1 || !asm[i + 1]) return null;
    return Utils.toBase58Check(Utils.toArray(asm[i + 1], "hex"));
  } catch {
    return null;
  }
}

export function verifyPaidPost(args: {
  rawTx: string;
  /** The content we are about to store — must be what was inscribed. */
  content: string;
  /** The author's address; must OWN the inscription, or they do not own the post. */
  authorAddress: string;
  /** Where the markup must land. Null disables the check (at-cost posting). */
  platformAddress: string | null;
  /** Minimum acceptable platform payment, in satoshis. */
  minPlatformSats: number;
}): PaidPostVerdict {
  let tx: Transaction;
  let txid: string;
  try {
    tx = Transaction.fromHex(args.rawTx);
    txid = tx.id("hex");
  } catch {
    return { ok: false, reason: "malformed_tx" };
  }
  if (!/^[a-f0-9]{64}$/.test(txid)) return { ok: false, reason: "malformed_tx" };

  const out = tx.outputs[INSCRIPTION_VOUT];
  if (!out?.lockingScript) return { ok: false, reason: "no_inscription" };

  const inscription = parseInscription(out.lockingScript as Script);
  if (!inscription) return { ok: false, reason: "no_inscription" };

  // The author must be able to spend the inscription, or "own what you post" is
  // simply false for this post.
  const owner = addressOf(out.lockingScript as Script);
  if (!owner || owner !== args.authorAddress) return { ok: false, reason: "wrong_owner" };

  let inscribedContent: string;
  try {
    const parsed = JSON.parse(Utils.toUTF8(inscription.data)) as { content?: unknown };
    if (typeof parsed.content !== "string") return { ok: false, reason: "content_mismatch" };
    inscribedContent = parsed.content;
  } catch {
    return { ok: false, reason: "content_mismatch" };
  }
  if (inscribedContent !== args.content) return { ok: false, reason: "content_mismatch" };

  // ⚠ A CONSERVATION FLOOR, NOT A RECOMPUTED PRICE. `boot-confirm` learned this
  // the expensive way: recomputing an exact split rejected legitimate drift and
  // a client retry then minted a new txid that DOUBLE-PAID. Check only that the
  // platform received AT LEAST what it is owed.
  if (args.platformAddress && args.minPlatformSats > 0) {
    let paid = 0;
    for (const o of tx.outputs) {
      if (!o.lockingScript || !o.satoshis) continue;
      if (addressOf(o.lockingScript as Script) === args.platformAddress) paid += o.satoshis;
    }
    if (paid < args.minPlatformSats) return { ok: false, reason: "platform_underpaid" };
  }

  return { ok: true, txid, vout: INSCRIPTION_VOUT };
}
