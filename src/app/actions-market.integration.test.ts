/**
 * The secondary market: listing units, and buying them from a holder.
 *
 * ⚠ EVERY TEST HERE IS AN ATTACK OR A LOSS. The buyer has already paid, peer to
 * peer, by the time the server sees a fill — so a mistake either takes their
 * money and gives them nothing, or gives them units the seller never had. Those
 * are the two things this suite exists to make impossible.
 */

import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/bsv/onchain", () => ({
  logPostOnChain: vi.fn().mockResolvedValue("mocktxid_post"),
}));
vi.mock("@/services/bsv/anchor-sweep", () => ({
  sweepOrphans: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/link-unfurl", () => ({
  unfurl: vi.fn().mockResolvedValue({ ok: false, url: "", reason: "fetch_failed" }),
}));
vi.mock("@/services/bsv/wallet", () => ({
  isServerSpendDisabled: vi.fn().mockReturnValue(false),
  getServerAddress: vi.fn().mockReturnValue("1PlatformAddressForTests"),
  getBalance: vi.fn().mockResolvedValue(500_000),
  buildAndBroadcast: vi.fn(),
  SERVER_FEE_BUFFER_SATS: 300,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(
    new Map([
      ["x-forwarded-for", "10.0.0.55"],
      ["x-real-ip", "10.0.0.55"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { creditUnits, unitsHeld } from "@/lib/holdings";
import { cancelListingMessage, fillMessage, listMessage } from "@/lib/listing-message";
import { unitsListable } from "@/lib/market";
import { cancelListing, fillListing, getFillQuote, getListings, listUnits } from "./actions";

function who() {
  const key = PrivateKey.fromRandom();
  return {
    key,
    pubkey: key.toPublicKey().toString(),
    address: key.toPublicKey().toAddress().toString(),
    sign(message: string) {
      return key.sign(Array.from(new TextEncoder().encode(message))).toDER("hex") as string;
    },
  };
}

type Who = ReturnType<typeof who>;

/** Give somebody units the way a mint would. */
function grant(symbol: string, holder: Who, units: number) {
  creditUnits(symbol, holder.pubkey, units);
}

async function list(seller: Who, symbol: string, units: number, priceSats: number) {
  const fd = new FormData();
  fd.set("symbol", symbol);
  fd.set("units", String(units));
  fd.set("price_sats", String(priceSats));
  fd.set("pubkey", seller.pubkey);
  fd.set("signature", seller.sign(listMessage(symbol, units, priceSats)));
  return listUnits(fd);
}

/** A transaction paying `sats` to an address, the way a buyer's wallet builds one. */
function payment(toAddress: string, sats: number, salt = 0): string {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(toAddress), satoshis: sats });
  // A second output makes each transaction's bytes — and so its txid — distinct,
  // which is what lets one test broadcast two different payments.
  if (salt > 0) {
    tx.addOutput({ lockingScript: new P2PKH().lock(toAddress), satoshis: salt });
  }
  return tx.toHex();
}

async function fill(buyer: Who, listingId: number, units: number, rawTx: string) {
  const txid = Transaction.fromHex(rawTx).id("hex");
  const fd = new FormData();
  fd.set("listing_id", String(listingId));
  fd.set("units", String(units));
  fd.set("raw_tx", rawTx);
  fd.set("pubkey", buyer.pubkey);
  fd.set("signature", buyer.sign(fillMessage(listingId, units, txid)));
  return fillListing(fd);
}

beforeEach(() => {
  db.exec("DELETE FROM listing_fills");
  db.exec("DELETE FROM listings");
  db.exec("DELETE FROM ticker_holdings");
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("listing units", () => {
  it("lists what the seller holds", async () => {
    const seller = who();
    grant("OCCAM", seller, 10);
    const res = await list(seller, "OCCAM", 4, 500);
    expect(res.ok).toBe(true);

    const book = await getListings("OCCAM");
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ symbol: "OCCAM", unitsLeft: 4, priceSats: 500 });
  });

  it("REFUSES to list units the seller does not hold", async () => {
    const seller = who();
    grant("OCCAM", seller, 2);
    expect(await list(seller, "OCCAM", 3, 500)).toEqual({ ok: false, reason: "not_enough_units" });
  });

  it("REFUSES to list the same units twice", async () => {
    // Otherwise ten units could be sold four times over and only the fourth
    // buyer would discover it.
    const seller = who();
    grant("OCCAM", seller, 10);
    expect((await list(seller, "OCCAM", 8, 500)).ok).toBe(true);
    expect(await list(seller, "OCCAM", 8, 400)).toEqual({ ok: false, reason: "not_enough_units" });
    expect(unitsListable("OCCAM", seller.pubkey)).toBe(2);
  });

  it("REFUSES a forged signature", async () => {
    const seller = who();
    grant("OCCAM", seller, 5);
    const fd = new FormData();
    fd.set("symbol", "OCCAM");
    fd.set("units", "5");
    fd.set("price_sats", "500");
    fd.set("pubkey", seller.pubkey);
    fd.set("signature", who().sign(listMessage("OCCAM", 5, 500)));
    expect(await listUnits(fd)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("REFUSES a signature over different terms", async () => {
    // A captured signature must not authorise a cheaper price or a bigger size.
    const seller = who();
    grant("OCCAM", seller, 5);
    const fd = new FormData();
    fd.set("symbol", "OCCAM");
    fd.set("units", "5");
    fd.set("price_sats", "1");
    fd.set("pubkey", seller.pubkey);
    fd.set("signature", seller.sign(listMessage("OCCAM", 5, 500)));
    expect(await listUnits(fd)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("refuses nonsense terms", async () => {
    const seller = who();
    grant("OCCAM", seller, 5);
    expect(await list(seller, "OCCAM", 0, 500)).toEqual({ ok: false, reason: "invalid_terms" });
    expect(await list(seller, "OCCAM", 1, 0)).toEqual({ ok: false, reason: "invalid_terms" });
    expect(await list(seller, "$50", 1, 500)).toEqual({ ok: false, reason: "invalid_terms" });
  });
});

describe("cancelling", () => {
  it("takes the offer off the book and frees the units", async () => {
    const seller = who();
    grant("OCCAM", seller, 5);
    const res = await list(seller, "OCCAM", 5, 500);
    if (!res.ok) throw new Error("expected a listing");

    const fd = new FormData();
    fd.set("listing_id", String(res.id));
    fd.set("pubkey", seller.pubkey);
    fd.set("signature", seller.sign(cancelListingMessage(res.id)));
    expect(await cancelListing(fd)).toEqual({ ok: true });
    expect(await getListings("OCCAM")).toHaveLength(0);
    expect(unitsListable("OCCAM", seller.pubkey)).toBe(5);
  });

  it("REFUSES to let somebody cancel another seller's offer", async () => {
    const seller = who();
    grant("OCCAM", seller, 5);
    const res = await list(seller, "OCCAM", 5, 500);
    if (!res.ok) throw new Error("expected a listing");

    const attacker = who();
    const fd = new FormData();
    fd.set("listing_id", String(res.id));
    fd.set("pubkey", attacker.pubkey);
    fd.set("signature", attacker.sign(cancelListingMessage(res.id)));
    expect(await cancelListing(fd)).toEqual({ ok: false });
    expect(await getListings("OCCAM")).toHaveLength(1);
  });
});

describe("filling", () => {
  async function book(price = 500, units = 5) {
    const seller = who();
    grant("OCCAM", seller, Math.max(10, units));
    const res = await list(seller, "OCCAM", units, price);
    if (!res.ok) throw new Error("expected a listing");
    return { seller, id: res.id, price };
  }

  it("moves the units when the seller was paid", async () => {
    const { seller, id, price } = await book();
    const buyer = who();
    expect(await fill(buyer, id, 3, payment(seller.address, 3 * price))).toEqual({
      ok: true,
      units: 3,
    });
    expect(unitsHeld("OCCAM", buyer.pubkey)).toBe(3);
    expect(unitsHeld("OCCAM", seller.pubkey)).toBe(7);
    // Supply is unchanged — a sale moves units, it does not mint them.
    expect(unitsHeld("OCCAM", buyer.pubkey) + unitsHeld("OCCAM", seller.pubkey)).toBe(10);
  });

  it("REFUSES a fill that underpaid", async () => {
    const { seller, id, price } = await book();
    const buyer = who();
    expect(await fill(buyer, id, 3, payment(seller.address, 3 * price - 1))).toEqual({
      ok: false,
      reason: "underpaid",
    });
    expect(unitsHeld("OCCAM", buyer.pubkey)).toBe(0);
  });

  it("REFUSES a payment sent to somebody else", async () => {
    const { id, price } = await book();
    const buyer = who();
    // Paying an address of your own choosing must not buy anything.
    expect(await fill(buyer, id, 3, payment(buyer.address, 3 * price))).toEqual({
      ok: false,
      reason: "underpaid",
    });
  });

  it("ACCEPTS an overpayment — the buyer already broadcast", async () => {
    // Rejecting here would take their money and give them nothing.
    const { seller, id, price } = await book();
    const buyer = who();
    expect((await fill(buyer, id, 2, payment(seller.address, 2 * price + 1000))).ok).toBe(true);
  });

  it("REFUSES to replay one payment for two fills", async () => {
    // A big enough offer that the SECOND attempt is refused by the replay guard
    // rather than by running out of stock — which would test nothing.
    const { seller, id, price } = await book(500, 10);
    const buyer = who();
    const tx = payment(seller.address, 3 * price);
    expect((await fill(buyer, id, 3, tx)).ok).toBe(true);
    expect(await fill(buyer, id, 3, tx)).toEqual({ ok: false, reason: "replay" });
    expect(unitsHeld("OCCAM", buyer.pubkey)).toBe(3);
  });

  it("REFUSES a forged buyer signature", async () => {
    const { seller, id, price } = await book();
    const buyer = who();
    const rawTx = payment(seller.address, 2 * price);
    const txid = Transaction.fromHex(rawTx).id("hex");
    const fd = new FormData();
    fd.set("listing_id", String(id));
    fd.set("units", "2");
    fd.set("raw_tx", rawTx);
    fd.set("pubkey", buyer.pubkey);
    fd.set("signature", who().sign(fillMessage(id, 2, txid)));
    expect(await fillListing(fd)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("REFUSES to buy more than the offer holds", async () => {
    const { seller, id, price } = await book(500, 5);
    const buyer = who();
    expect(await fill(buyer, id, 6, payment(seller.address, 6 * price))).toEqual({
      ok: false,
      reason: "invalid_terms",
    });
  });

  it("REFUSES when the seller no longer holds the units", async () => {
    // The check that actually protects the buyer: holdings move between listing
    // and filling.
    const { seller, id, price } = await book();
    db.prepare("UPDATE ticker_holdings SET units = 1 WHERE symbol = 'OCCAM' AND pubkey = ?").run(
      seller.pubkey
    );
    const buyer = who();
    expect(await fill(buyer, id, 3, payment(seller.address, 3 * price))).toEqual({
      ok: false,
      reason: "seller_short",
    });
    expect(unitsHeld("OCCAM", buyer.pubkey)).toBe(0);
  });

  it("REFUSES a seller buying from themselves", async () => {
    const { seller, id, price } = await book();
    expect(await fill(seller, id, 2, payment(seller.address, 2 * price))).toEqual({
      ok: false,
      reason: "invalid_terms",
    });
  });

  it("closes the offer when it sells out, and leaves it open when it does not", async () => {
    const { seller, id, price } = await book(500, 5);
    expect((await fill(who(), id, 2, payment(seller.address, 2 * price, 1))).ok).toBe(true);
    expect((await getListings("OCCAM"))[0]).toMatchObject({ unitsLeft: 3 });

    expect((await fill(who(), id, 3, payment(seller.address, 3 * price, 2))).ok).toBe(true);
    expect(await getListings("OCCAM")).toHaveLength(0);
  });

  it("quotes what to pay and where", async () => {
    const { seller, id, price } = await book();
    expect(await getFillQuote(id, 3)).toEqual({
      ok: true,
      address: seller.address,
      totalSats: 3 * price,
    });
    // More than is left has no quote, so a buyer cannot build a transaction for
    // a purchase that will be refused after they broadcast it.
    expect(await getFillQuote(id, 99)).toEqual({ ok: false });
  });
});
