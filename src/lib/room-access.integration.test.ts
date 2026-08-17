/**
 * A named thread is a room, and a unit of its token is the ticket — BURNED at the
 * door.
 *
 * The tests that matter are the ones that would let somebody in for nothing: the
 * board's own thread must never lock, a nameless thread must never lock, and
 * naming the room's ticker in a reply must not buy you in on the way through the
 * door.
 *
 * ⚠ AND, SINCE ENTRY BURNS, THE ONE THAT WOULD LOCK OUT SOMEBODY WHO PAID.
 * Membership is what grants access, not a balance — a member's balance is zero by
 * construction, so a gate that tested units excluded exactly the people who had
 * bought their way in, while admitting anybody merely holding stock they had never
 * spent at the door. `held` is now stock, `entered` is access, and these assert the
 * difference in both directions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { creditUnits } from "./holdings";
import { MINT_BASE_SATS } from "./mint-price";
import { enterRoom, heldUnits, mayEnter, roomAccess, roomTickerFor } from "./room-access";
import { ROOT_TICKER } from "./ticker";

const HOLDER = "pk_holder";
const STRANGER = "pk_stranger";

/** A thread claimed under `symbol`, returning its root id. */
function room(symbol: string | null, opts: { units?: number; holder?: string } = {}): number {
  const rootId = db
    .prepare("INSERT INTO posts (content, author_name, pubkey) VALUES (?, 'anon_room', ?)")
    .run(symbol ? `starting $${symbol}` : "no name here", opts.holder ?? HOLDER)
    .lastInsertRowid as number;
  db.prepare("UPDATE posts SET root_id = id WHERE id = ?").run(rootId);
  if (symbol) {
    db.prepare("INSERT INTO tickers (symbol, post_id, root_id, pubkey) VALUES (?, ?, ?, ?)").run(
      symbol,
      rootId,
      rootId,
      opts.holder ?? HOLDER
    );
    db.prepare(
      `INSERT INTO ticker_mentions (symbol, post_id, pubkey, target_type, units)
       VALUES (?, ?, ?, 'none', ?)`
    ).run(symbol, rootId, opts.holder ?? HOLDER, opts.units ?? 1);
    // The ownership ledger is what the door reads — see the note in the
    // mint-charge suite on why the harness has to write both.
    creditUnits(symbol, opts.holder ?? HOLDER, opts.units ?? 1);
  }
  return rootId;
}

beforeEach(() => {
  // ⚠ Membership too. It outlives holdings by design, so a suite that clears
  // only the ledger leaks members into the next test and every gate reads open.
  db.exec("DELETE FROM room_entries");
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM ticker_holdings");
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM posts");
});

describe("roomTickerFor", () => {
  it("finds the name a thread is claimed under", () => {
    expect(roomTickerFor(room("OCCAM"))).toBe("OCCAM");
  });

  it("is null for a thread with no name — not every thread is a room", () => {
    expect(roomTickerFor(room(null))).toBeNull();
  });

  it("NEVER gates the board's own thread", () => {
    // `$OpenBooks` is the front door. A ticket to the board would be a ticket to
    // the site, which is not what any of this is for.
    expect(roomTickerFor(room(ROOT_TICKER))).toBeNull();
  });

  it("is null for a thread that does not exist", () => {
    expect(roomTickerFor(999_999)).toBeNull();
  });
});

describe("heldUnits", () => {
  it("sums units, so a bought position counts for what it is", () => {
    const rootId = room("BULK", { units: 40 });
    expect(heldUnits("BULK", HOLDER)).toBe(40);
    expect(rootId).toBeGreaterThan(0);
  });

  it("is zero for a stranger and for a signed-out reader", () => {
    room("OCCAM");
    expect(heldUnits("OCCAM", STRANGER)).toBe(0);
    expect(heldUnits("OCCAM", null)).toBe(0);
  });
});

describe("roomAccess", () => {
  it("prices the door from the ISSUED supply", () => {
    const rootId = room("OCCAM", { units: 3 });
    const access = roomAccess(rootId, STRANGER);
    expect(access).toEqual({
      symbol: "OCCAM",
      gated: true,
      entered: false,
      held: 0,
      priceSats: 4 * MINT_BASE_SATS,
    });
  });

  it("does NOT drop the price when tickets are burned", () => {
    // ⚠ The inversion this guards: burning lowers held supply, so a door priced
    // off holdings gets CHEAPER as the room fills. Three units issued, all three
    // burned — the fourth entrant must still pay the fourth unit's price.
    const rootId = room("OCCAM", { units: 3 });
    const before = roomAccess(rootId, STRANGER).priceSats;
    enterRoom("OCCAM", HOLDER, { burnTxid: "t1", paidSats: before });
    enterRoom("OCCAM", HOLDER, { burnTxid: "t2", paidSats: before });
    enterRoom("OCCAM", HOLDER, { burnTxid: "t3", paidSats: before });
    expect(heldUnits("OCCAM", HOLDER)).toBe(2); // idempotent: only one burned
    expect(roomAccess(rootId, STRANGER).priceSats).toBe(before);
  });

  it("reports a holder's spare units separately from their membership", () => {
    const rootId = room("OCCAM", { units: 2 });
    const access = roomAccess(rootId, HOLDER);
    expect(access.held).toBe(2);
    // Holding is not being in. Nothing has been burned yet.
    expect(access.entered).toBe(false);
  });

  it("is not gated at all when the thread has no name", () => {
    const access = roomAccess(room(null), STRANGER);
    expect(access.gated).toBe(false);
    expect(access.symbol).toBeNull();
  });
});

describe("mayEnter", () => {
  it("lets a MEMBER in — somebody who burned a ticket", () => {
    const rootId = room("OCCAM");
    expect(enterRoom("OCCAM", HOLDER, { burnTxid: "t1", paidSats: 113 }).ok).toBe(true);
    expect(mayEnter(rootId, HOLDER)).toBe(true);
  });

  it("KEEPS OUT a holder who has not burned anything", () => {
    // ⚠ The hole burning closed. Under hold-to-enter this was `true`, and one
    // unit could admit an unlimited chain of people in sequence: buy, enter, sell
    // on, repeat — the room paid once for all of them.
    const rootId = room("OCCAM", { units: 5 });
    expect(heldUnits("OCCAM", HOLDER)).toBe(5);
    expect(mayEnter(rootId, HOLDER)).toBe(false);
  });

  it("lets a MEMBER in after their balance has gone to zero", () => {
    // ⚠ The failure in the other direction: a member's balance is zero because
    // they paid. Testing units locked out precisely the people who had.
    const rootId = room("OCCAM", { units: 1 });
    enterRoom("OCCAM", HOLDER, { burnTxid: "t1", paidSats: 113 });
    expect(heldUnits("OCCAM", HOLDER)).toBe(0);
    expect(mayEnter(rootId, HOLDER)).toBe(true);
  });

  it("KEEPS THE FOUNDER OUT until they burn one too — no exemption", () => {
    // ⚠ THERE WAS AN EXEMPTION HERE FOR ABOUT AN HOUR, and the owner removed it:
    // "tickets are BURNED on entry, period." Founding mints them a unit and admits
    // them to nothing. One rule: every membership cost one destroyed ticket.
    const rootId = room("OCCAM", { units: 1 });
    expect(heldUnits("OCCAM", HOLDER)).toBe(1);
    expect(mayEnter(rootId, HOLDER)).toBe(false);

    expect(enterRoom("OCCAM", HOLDER, { burnTxid: "t1", paidSats: 113 }).ok).toBe(true);
    expect(heldUnits("OCCAM", HOLDER)).toBe(0);
    expect(mayEnter(rootId, HOLDER)).toBe(true);
  });

  it("keeps a stranger out", () => {
    expect(mayEnter(room("OCCAM"), STRANGER)).toBe(false);
  });

  it("keeps a signed-out reader out", () => {
    expect(mayEnter(room("OCCAM"), null)).toBe(false);
  });

  it("lets ANYONE into a thread with no name", () => {
    expect(mayEnter(room(null), STRANGER)).toBe(true);
    expect(mayEnter(room(null), null)).toBe(true);
  });

  it("lets anyone into the board's own thread", () => {
    expect(mayEnter(room(ROOT_TICKER), STRANGER)).toBe(true);
  });

  it("lets a stranger into a thread that does not exist rather than throwing", () => {
    // A missing thread is `invalid_parent`'s problem, not the door's — failing
    // here would turn a 404 into a paywall.
    expect(mayEnter(999_999, STRANGER)).toBe(true);
  });
});
