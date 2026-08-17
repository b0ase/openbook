/**
 * Burning a ticket at the door.
 *
 * ⚠ WHY BURNING EXISTS. Under hold-to-enter, one unit admitted an unlimited number
 * of members in sequence — buy, enter, sell to the next person, they enter, sell
 * on. Every holder in that chain was legitimately inside while they held, and the
 * room got paid ONCE for all of them. Burning makes the arithmetic honest: N
 * members means N units destroyed means N payments up the curve.
 *
 * ⚠ AND WHY THE PRICE MUST NOT READ HELD SUPPLY. A burn lowers held supply, so a
 * price taken from it FALLS as the room fills — a room getting cheaper the more
 * popular it is. That is asserted here directly, because it is the failure that
 * inverts the whole economics while every individual number still looks plausible.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { burnUnits, creditUnits, mintedUnits, totalUnits, unitsHeld } from "@/lib/holdings";
import { mintPriceSats } from "@/lib/mint-price";
import { enterRoom, hasEntered } from "@/lib/room-access";

const ALICE = "02aa";
const BOB = "02bb";
const SYM = "OCCAM";

beforeEach(() => {
  db.exec("DELETE FROM room_entries");
  db.exec("DELETE FROM ticker_holdings");
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM posts");
});

/**
 * Mint `units` to `pubkey` the way a post does: history AND ownership, in that
 * order, priced at the curve position before the mint — which is what
 * `recordTickerMentions` does and why the two counters can be compared at all.
 */
function mint(symbol: string, pubkey: string, units: number) {
  const paid = mintPriceSats(mintedUnits(symbol));
  // `ticker_mentions.post_id` is a real foreign key, so a mention needs a post.
  const postId = db
    .prepare("INSERT INTO posts (content, author_name) VALUES (?, 'anon_test')")
    .run(`$${symbol}`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO ticker_mentions (symbol, post_id, pubkey, target_type, units, paid_sats)
     VALUES (?, ?, ?, 'none', ?, ?)`
  ).run(symbol, postId, pubkey, units, paid);
  creditUnits(symbol, pubkey, units);
}

describe("the price does not fall when tickets burn", () => {
  it("keeps rising as members enter — the inversion this replaced", () => {
    mint(SYM, ALICE, 1);
    mint(SYM, BOB, 1);
    const priceBefore = mintPriceSats(mintedUnits(SYM));

    expect(enterRoom(SYM, ALICE, { burnTxid: "t1", paidSats: priceBefore })).toEqual({
      ok: true,
      alreadyMember: false,
    });
    expect(enterRoom(SYM, BOB, { burnTxid: "t2", paidSats: priceBefore })).toEqual({
      ok: true,
      alreadyMember: false,
    });

    // Held supply has collapsed to nothing — both tickets are destroyed.
    expect(totalUnits(SYM)).toBe(0);
    // ⚠ AND THE PRICE HAS NOT MOVED DOWN. Priced off held supply it would now be
    // back at base, so the third member would pay LESS than the first two.
    expect(mintedUnits(SYM)).toBe(2);
    expect(mintPriceSats(mintedUnits(SYM))).toBe(priceBefore);
    expect(mintPriceSats(mintedUnits(SYM))).toBeGreaterThan(mintPriceSats(totalUnits(SYM)));
  });

  it("charges the third member more than the first", () => {
    mint(SYM, ALICE, 1);
    const first = mintPriceSats(mintedUnits(SYM));
    enterRoom(SYM, ALICE, { burnTxid: "t1", paidSats: first });
    mint(SYM, BOB, 1);
    const second = mintPriceSats(mintedUnits(SYM));
    expect(second).toBeGreaterThan(first);
  });
});

describe("entry", () => {
  it("destroys the ticket and grants membership together", () => {
    mint(SYM, ALICE, 1);
    expect(unitsHeld(SYM, ALICE)).toBe(1);
    expect(hasEntered(SYM, ALICE)).toBe(false);

    const res = enterRoom(SYM, ALICE, { burnTxid: "tx1", paidSats: 113 });
    expect(res).toEqual({ ok: true, alreadyMember: false });
    expect(unitsHeld(SYM, ALICE)).toBe(0);
    expect(hasEntered(SYM, ALICE)).toBe(true);
  });

  it("REFUSES somebody with no ticket, and destroys nothing", () => {
    const res = enterRoom(SYM, ALICE, { burnTxid: "tx1", paidSats: 113 });
    expect(res).toEqual({ ok: false, reason: "no_ticket" });
    expect(hasEntered(SYM, ALICE)).toBe(false);
    expect(totalUnits(SYM)).toBe(0);
  });

  it("does NOT charge a second ticket for a second tap", () => {
    // ⚠ A lost response, or an impatient double-tap, must not cost another
    // ticket. Idempotence here is money, not tidiness.
    mint(SYM, ALICE, 2);
    enterRoom(SYM, ALICE, { burnTxid: "tx1", paidSats: 113 });
    expect(unitsHeld(SYM, ALICE)).toBe(1);

    const again = enterRoom(SYM, ALICE, { burnTxid: "tx2", paidSats: 226 });
    expect(again).toEqual({ ok: true, alreadyMember: true });
    expect(unitsHeld(SYM, ALICE)).toBe(1);
  });

  it("burns exactly one, leaving the rest sellable", () => {
    mint(SYM, ALICE, 5);
    enterRoom(SYM, ALICE, { burnTxid: "tx1", paidSats: 113 });
    expect(unitsHeld(SYM, ALICE)).toBe(4);
  });

  it("does not admit one member on another's ticket", () => {
    mint(SYM, ALICE, 1);
    expect(enterRoom(SYM, BOB, { burnTxid: "tx1", paidSats: 113 })).toEqual({
      ok: false,
      reason: "no_ticket",
    });
    // Alice's ticket is untouched.
    expect(unitsHeld(SYM, ALICE)).toBe(1);
  });

  it("records what the door charged, for the member's own card", () => {
    mint(SYM, ALICE, 1);
    enterRoom(SYM, ALICE, { burnTxid: "tx1", paidSats: 452 });
    const row = db
      .prepare("SELECT burn_txid, paid_sats FROM room_entries WHERE symbol = ? AND pubkey = ?")
      .get(SYM, ALICE) as { burn_txid: string; paid_sats: number };
    expect(row).toEqual({ burn_txid: "tx1", paid_sats: 452 });
  });
});

describe("burnUnits", () => {
  it("refuses to overdraw rather than going negative", () => {
    mint(SYM, ALICE, 1);
    expect(burnUnits(SYM, ALICE, 2)).toBe(false);
    expect(unitsHeld(SYM, ALICE)).toBe(1);
  });

  it("refuses a zero or negative burn", () => {
    mint(SYM, ALICE, 1);
    expect(burnUnits(SYM, ALICE, 0)).toBe(false);
    expect(burnUnits(SYM, ALICE, -1)).toBe(false);
    expect(unitsHeld(SYM, ALICE)).toBe(1);
  });

  it("cannot unmint history", () => {
    // The whole basis of the price surviving a burn.
    mint(SYM, ALICE, 3);
    burnUnits(SYM, ALICE, 3);
    expect(totalUnits(SYM)).toBe(0);
    expect(mintedUnits(SYM)).toBe(3);
  });
});
