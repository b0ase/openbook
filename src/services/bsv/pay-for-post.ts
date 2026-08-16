import { onchainRecord } from "@/lib/onchain-record";
import { currentFeeRateSatsPerKb, postPrice } from "@/lib/post-economics";
import { clientSidePost } from "./client-post";

/**
 * Buy the on-chain slot for a post — for EVERY UI that creates one.
 *
 * ⚠ WHY THIS IS SHARED, AND WHY IT MUST STAY SHARED. Paid posting originally
 * lived inline in `PostForm` alone. `NymModal` is a second, entirely separate
 * route into `createPost`, and it never learned about payment — so the moment
 * `PAID_POSTING` was switched on in production, claiming a `$Nym` began failing
 * for everybody with a generic "Couldn't post that", while the compose box
 * carried on working. The bug was not a mistake in the payment code; it was
 * payment code that only one caller knew existed.
 *
 * **Anything that reaches `createPost` must come through here first.** If you
 * are adding a third way to post (a reply composer, an agent, an importer), call
 * this rather than re-deriving the payload and the price — the two are coupled
 * (the quote must be priced with the same fee rate the builder uses, or the
 * quote and the transaction disagree) and that coupling is easy to get subtly
 * wrong a second time.
 */

/**
 * The server's answer to "is posting paid right now, and on what terms".
 *
 * Re-exported from `actions` rather than redeclared: a second local copy of this
 * shape would drift from the one the server actually returns, and `import type`
 * is erased at build time so no server code reaches the client bundle.
 */
export type { PostingMode } from "@/app/actions";

import type { PostingMode } from "@/app/actions";

export type PayForPostResult =
  /** `rawTx` is null in free mode: there is nothing to attach, and that is not an error. */
  | { ok: true; rawTx: string | null }
  /** A `POST_FAILURE_TEXT` key. Nothing was broadcast, so nothing was spent. */
  | { ok: false; status: string };

export async function payForPost(args: {
  mode: PostingMode;
  wif: string;
  address: string;
  content: string;
  author: string;
  sig: string | null;
  pubkey: string | null;
  parent: number | null;
}): Promise<PayForPostResult> {
  if (!args.mode.paid) return { ok: true, rawTx: null };

  // The SAME envelope the server-funded path anchors, so a paid post and a free
  // one are the same record to anybody reading the chain.
  const payload = onchainRecord("post", {
    content: args.content,
    author: args.author,
    sig: args.sig,
    pubkey: args.pubkey,
    parent: args.parent,
  });

  // Price the WHOLE transaction, not the payload: the miner charges for the
  // transaction, and the envelope plus inputs and change dwarf the text on a
  // short post. Claiming a name is the shortest post there is — "I'm $Occam" —
  // which is exactly the case where pricing the payload alone underpays.
  const price = postPrice(payload.length + 600, {
    markupPercent: args.mode.markupPercent,
    // Same rate the transaction builder will use, so the quote and the
    // transaction cannot disagree.
    feeRateSatsPerKb: await currentFeeRateSatsPerKb(),
  });

  const paid = await clientSidePost(
    args.wif,
    args.address,
    payload,
    args.mode.platformAddress,
    price
  );

  // ⚠ NOTHING GOES TO THE SERVER ON FAILURE. A post the author did not pay for
  // must not be stored, and `createPost` would refuse it anyway.
  if (paid.status !== "success") return { ok: false, status: paid.status };
  return { ok: true, rawTx: paid.rawTx };
}
