import { fillListing, getFillQuote } from "@/app/actions";
import { fillMessage } from "@/lib/listing-message";
import type { Identity } from "@/types";
import { clientSidePay } from "./client-pay";

/**
 * Buy units from another holder.
 *
 * ⚠ THE MONEY GOES STRAIGHT TO THE SELLER, and never through us. The browser
 * builds and broadcasts a transaction paying the seller's address; the server
 * then verifies those bytes and moves the ledger. This mirrors `clientSideBoot`
 * on purpose — that path is audited and this is the same trust model for the
 * money. What differs, and what `market.ts` states rather than hides, is that
 * the UNITS are a ledger entry, so applying the transfer is something the
 * platform is trusted to do.
 *
 * ⚠ ORDER MATTERS AND IT IS THE UNCOMFORTABLE ONE. Payment happens BEFORE the
 * server can confirm the transfer, because there is nothing to verify until the
 * bytes exist. So every check that can be made cheaply is made FIRST — the
 * quote confirms the listing is still open and still has the units — and the
 * failure message afterwards must never say "nothing was spent", because by
 * then something was.
 */

export type BuyListingResult =
  | { ok: true; units: number }
  /** Nothing was broadcast. Safe to say nothing was spent. */
  | { ok: false; message: string; spent: false }
  /** The payment went out. Do NOT tell the user their money is safe. */
  | { ok: false; message: string; spent: true; txid: string };

export async function buyListing(args: {
  identity: Identity;
  sign: (message: string) => Promise<{ signature: string; pubkey: string } | null>;
  listingId: number;
  units: number;
}): Promise<BuyListingResult> {
  const quote = await getFillQuote(args.listingId, args.units);
  if (!quote.ok) {
    return { ok: false, spent: false, message: "That offer is gone — nothing was spent." };
  }

  const paid = await clientSidePay(args.identity.wif, args.identity.address, {
    address: quote.address,
    satoshis: quote.totalSats,
  });
  if (paid.status !== "success") {
    return {
      ok: false,
      spent: false,
      message:
        paid.status === "insufficient_funds" || paid.status === "no_utxos"
          ? "Not enough funds — add some and try again. Nothing was spent."
          : "Couldn't send the payment — nothing was spent.",
    };
  }

  const signed = await args.sign(fillMessage(args.listingId, args.units, paid.txid));
  if (!signed) {
    return {
      ok: false,
      spent: true,
      txid: paid.txid,
      message: "Paid, but couldn't sign the claim. Keep this transaction id and contact support.",
    };
  }

  const fd = new FormData();
  fd.set("listing_id", String(args.listingId));
  fd.set("units", String(args.units));
  fd.set("raw_tx", paid.rawTx);
  fd.set("pubkey", signed.pubkey);
  fd.set("signature", signed.signature);

  const res = await fillListing(fd);
  if (res.ok) return { ok: true, units: res.units };

  // ⚠ THE PAYMENT IS ALREADY OUT. Every message below has to be honest about
  // that — a "try again" here would invite somebody to pay twice.
  return {
    ok: false,
    spent: true,
    txid: paid.txid,
    message:
      res.reason === "seller_short"
        ? "The seller no longer holds those units. Your payment went through — keep this transaction id."
        : res.reason === "gone"
          ? "That offer was taken while you were paying. Your payment went through — keep this transaction id."
          : "The purchase could not be completed. Your payment went through — keep this transaction id.",
  };
}
