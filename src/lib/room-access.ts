import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";
import { totalUnits, unitsHeld } from "./holdings";
import { mintPriceSats } from "./mint-price";
import { isRootTicker } from "./ticker";

type Db = ReturnType<typeof Database>;

/**
 * A named thread is a ROOM, and one unit of its token is the ticket.
 *
 * ⚠ THIS IS WHAT A TOKEN IS FOR, and until now nothing answered that. A unit
 * recorded provenance and nothing else, so `/$occam` was — the owner's words —
 * *"non-linear, not a chatroom, not a thread, and not coherent"*: an open page
 * anybody could wander into, where nothing was at stake and nothing held it
 * together. Charging one unit at the door is what turns a page into a room, and
 * it is what makes the curve mean something: the price of a ticket rises as the
 * room fills, an early ticket is worth what a late one costs, and the holder can
 * sell their seat.
 *
 * ⚠ WHAT THIS GATE IS AND IS NOT — say it plainly, because overstating it would
 * be a lie about somebody's privacy. **It is an access rule for this app, not
 * secrecy.** Every post is inscribed on chain by design, so anyone who indexes
 * the chain can read a room's contents whether or not they hold a ticket. That
 * is permanence working as intended and it cannot be walked back. What the gate
 * does is decide who can take part HERE.
 *
 * The two halves are enforced differently, on purpose:
 *
 *  - **WRITING is enforced cryptographically.** A reply goes through
 *    `createPost`, which verifies a signature over the content, so the pubkey
 *    that must hold a ticket is a pubkey the author has proved they control.
 *  - **READING is enforced as a product boundary.** A read gate would key on a
 *    pubkey nobody signed for, and holdings are public (the leaderboard prints
 *    them) — so anybody could pass a holder's key. Adding a signature round-trip
 *    per page open to protect content that is publicly readable on chain anyway
 *    would be theatre with a real cost in latency.
 *
 * The main feed is NEVER a room: `$OpenBooks` is the board itself, so gating it
 * would gate the front door.
 */

export interface RoomAccess {
  /** The ticker this thread is claimed under, or null if it has no name. */
  symbol: string | null;
  /** Whether a ticket is required at all. A nameless thread is not a room. */
  gated: boolean;
  /** Units the asking key holds. Zero for a signed-out reader. */
  held: number;
  /** What one ticket costs to mint right now — what the door charges. */
  priceSats: number;
}

/** The ticker a thread is claimed under, ignoring the board's own name. */
export function roomTickerFor(rootId: number, database: Db = defaultDb): string | null {
  if (!Number.isInteger(rootId) || rootId <= 0) return null;
  const row = database
    .prepare(
      "SELECT symbol FROM tickers WHERE root_id = ? ORDER BY post_id ASC, symbol ASC LIMIT 1"
    )
    .get(rootId) as { symbol: string } | undefined;
  const symbol = row?.symbol ?? null;
  // The board is not a room it can lock you out of.
  return symbol && !isRootTicker(symbol) ? symbol : null;
}

/**
 * How many units of a symbol a key holds — from the OWNERSHIP LEDGER.
 *
 * A thin re-export so the door reads holdings the same way the market and the
 * wallet do. Somebody who SOLD their last ticket is out; somebody who bought one
 * second-hand is in. Counting mention rows would get both backwards.
 */
export function heldUnits(symbol: string, pubkey: string | null, database: Db = defaultDb): number {
  return unitsHeld(symbol, pubkey, database);
}

/** Whether this key may take part in this thread, and what the door costs. */
export function roomAccess(
  rootId: number,
  pubkey: string | null,
  database: Db = defaultDb
): RoomAccess {
  const symbol = roomTickerFor(rootId, database);
  if (!symbol) return { symbol: null, gated: false, held: 0, priceSats: 0 };
  const held = heldUnits(symbol, pubkey, database);
  return { symbol, gated: true, held, priceSats: mintPriceSats(totalUnits(symbol, database)) };
}

/** Whether a key may post into this thread. `true` for anything that is not a room. */
export function mayEnter(rootId: number, pubkey: string | null, database: Db = defaultDb): boolean {
  const access = roomAccess(rootId, pubkey, database);
  return !access.gated || access.held > 0;
}
