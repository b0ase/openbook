import { createPost, getPostingMode } from "@/app/actions";
import type { Identity } from "@/types";
import { payForPost } from "./pay-for-post";

/**
 * Buy units of a token — from the compose box or from a room's door.
 *
 * ⚠ ONE SUBMITTER, FOR THE REASON `pay-for-post.ts` EXISTS. There are now two
 * places somebody can buy: typing `/buy 1000 $X`, and tapping "Buy a ticket" on
 * a room they cannot enter. A second copy of this sequence is exactly the shape
 * of the bug that made claiming a `$Nym` fail silently for everybody — a route
 * into `createPost` that did not know payment existed.
 *
 * A buy IS a post: the canonical command is the content, signed, inscribed, and
 * re-parsed server-side to decide what to mint. So it inherits the signature
 * check, the content screen, the rate limit, the payment verification and the
 * replay guard with no second pipeline.
 *
 * ⚠ IT IS ALWAYS A ROOT POST, never a reply — `parent: null`, deliberately. A
 * ticket is bought at the door of a room you cannot yet post in, so submitting
 * the purchase as a reply would be refused by the very gate it exists to open.
 */

export type BuyResult =
  | { ok: true }
  /** Nothing was broadcast, so nothing was spent. */
  | { ok: false; message: string };

export async function executeBuy(args: {
  identity: Identity;
  /** The identity context's signer — same one every other write path uses. */
  sign: (message: string) => Promise<{ signature: string; pubkey: string } | null>;
  /** The CANONICAL command text, from `buyCommandText`. */
  text: string;
}): Promise<BuyResult> {
  const signed = await args.sign(args.text);
  if (!signed) return { ok: false, message: "Couldn't sign that — try again." };

  const mode = await getPostingMode();
  const paid = await payForPost({
    mode,
    wif: args.identity.wif,
    address: args.identity.address,
    content: args.text,
    author: args.identity.name,
    sig: signed.signature,
    pubkey: signed.pubkey,
    parent: null,
  });
  if (!paid.ok) {
    return {
      ok: false,
      message:
        paid.status === "insufficient_funds" || paid.status === "no_utxos"
          ? "Not enough funds — add some and try again. Nothing was spent."
          : "Couldn't pay for that — nothing was spent. Try again.",
    };
  }

  const fd = new FormData();
  fd.set("content", args.text);
  fd.set("author", args.identity.name);
  fd.set("pubkey", signed.pubkey);
  fd.set("signature", signed.signature);
  if (paid.rawTx) fd.set("raw_tx", paid.rawTx);

  const res = await createPost(fd);
  if (res.ok) return { ok: true };
  return {
    ok: false,
    message:
      res.reason === "invalid_payment"
        ? "The price moved while you were buying — try again."
        : "Couldn't complete that purchase.",
  };
}
