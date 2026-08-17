/**
 * A named thread is a room, and one unit of its token is the ticket.
 *
 * The tests that matter are the ones that would let somebody in for nothing:
 * the board's own thread must never lock, a nameless thread must never lock,
 * and naming the room's ticker in a reply must not buy you in on the way
 * through the door.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { creditUnits } from "./holdings";
import { MINT_BASE_SATS } from "./mint-price";
import { heldUnits, mayEnter, roomAccess, roomTickerFor } from "./room-access";
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
  it("prices the door from the CURRENT supply", () => {
    const rootId = room("OCCAM", { units: 3 });
    const access = roomAccess(rootId, STRANGER);
    expect(access).toEqual({
      symbol: "OCCAM",
      gated: true,
      held: 0,
      priceSats: 4 * MINT_BASE_SATS,
    });
  });

  it("reports a holder's units", () => {
    const rootId = room("OCCAM", { units: 2 });
    expect(roomAccess(rootId, HOLDER).held).toBe(2);
  });

  it("is not gated at all when the thread has no name", () => {
    const access = roomAccess(room(null), STRANGER);
    expect(access.gated).toBe(false);
    expect(access.symbol).toBeNull();
  });
});

describe("mayEnter", () => {
  it("lets a holder in", () => {
    expect(mayEnter(room("OCCAM"), HOLDER)).toBe(true);
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
