import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";
import { burnUnits, mintedUnits, unitsHeld } from "./holdings";
import { mintPriceSats } from "./mint-price";
import { isRootTicker } from "./ticker";

type Db = ReturnType<typeof Database>;

/**
 * A named thread is a ROOM, and a unit of its token is the ticket — BURNED at the
 * door.
 *
 * ⚠ THE TICKET IS DESTROYED ON ENTRY, WHICH IS A REVERSAL OF HOLD-TO-ENTER, and
 * it was not a stylistic change. Two reasons, either of which is sufficient:
 *
 *  1. **A held ticket is reusable across PEOPLE.** With resale live, one unit
 *     admits an unlimited number of members in sequence — buy, enter, sell to the
 *     next person, they enter, sell on. Every holder in that chain is legitimately
 *     inside while they hold, and the room gets paid ONCE for all of them.
 *     Burning makes the arithmetic honest: N members means N units destroyed
 *     means N payments up the curve. This is a counting error, not a matter of
 *     opinion.
 *  2. **Hold-to-access is the shape of a security; consumption is not.** A thing
 *     you keep, watch appreciate and draw ongoing rights from looks like an
 *     investment. A thing you buy and use up is a ticket. Not a legal opinion —
 *     the mechanism difference is simply real, and it was the owner's call.
 *
 * ⚠ MEMBERSHIP IS PERMANENT, AND THE BURN TRANSACTION IS WHAT PROVES IT. A ticket
 * is torn once; charging per visit would mean paying to re-read a room you already
 * joined. So the burn is recorded in `room_entries` with its txid, which is on
 * chain, permanent, and names the room it bought — membership is a chain fact we
 * index rather than a balance we are trusted about. **But it is not yet CHECKED
 * against the chain** (see DEPLOY.md on the indexer), so do not call this gate
 * trustless.
 *
 * ⚠ WHAT THIS GATE IS AND IS NOT — say it plainly, because overstating it would
 * be a lie about somebody's privacy. **It is an access rule for this app, not
 * secrecy.** Every post is inscribed on chain by design, so anyone who indexes
 * the chain can read a room's contents whether or not they ever paid. That is
 * permanence working as intended and it cannot be walked back. What the gate does
 * is decide who can take part HERE.
 *
 * The two halves are enforced differently, on purpose:
 *
 *  - **WRITING is enforced cryptographically.** A reply goes through
 *    `createPost`, which verifies a signature over the content, so the pubkey
 *    whose membership is checked is one the author has proved they control.
 *  - **READING is enforced as a product boundary.** A read gate would key on a
 *    pubkey nobody signed for, and membership is public — so anybody could pass a
 *    member's key. Adding a signature round-trip per page open to protect content
 *    that is publicly readable on chain anyway would be theatre with a real cost
 *    in latency.
 *
 * The main feed is NEVER a room: `$OpenBooks` is the board itself, so gating it
 * would gate the front door.
 */

export interface RoomAccess {
  /** The ticker this thread is claimed under, or null if it has no name. */
  symbol: string | null;
  /** Whether a ticket is required at all. A nameless thread is not a room. */
  gated: boolean;
  /**
   * Whether this key has already burned a ticket and is a member.
   *
   * ⚠ THIS, NOT `held`, IS WHAT GRANTS ACCESS. A member's balance is zero by
   * construction, so a gate that checked units would lock out precisely the
   * people who had paid.
   */
  entered: boolean;
  /**
   * Unburned tickets this key holds — what it could spend at the door, or sell.
   *
   * Not access. A member usually has none; someone with ten has ten to trade and
   * needs to burn exactly one to get in.
   */
  held: number;
  /** What a ticket costs to mint right now — what the door charges. */
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
 * Unburned units of a symbol a key holds — from the OWNERSHIP LEDGER.
 *
 * A thin re-export so the door reads holdings the same way the market and the
 * wallet do. Note this is *tradeable stock*, not membership: see `hasEntered`.
 */
export function heldUnits(symbol: string, pubkey: string | null, database: Db = defaultDb): number {
  return unitsHeld(symbol, pubkey, database);
}

/** Whether this key has burned a ticket for this room. */
export function hasEntered(
  symbol: string,
  pubkey: string | null,
  database: Db = defaultDb
): boolean {
  if (!pubkey) return false;
  const row = database
    .prepare("SELECT 1 AS ok FROM room_entries WHERE symbol = ? AND pubkey = ?")
    .get(symbol, pubkey) as { ok: number } | undefined;
  return row !== undefined;
}

/** Whether this key may take part in this thread, and what the door costs. */
export function roomAccess(
  rootId: number,
  pubkey: string | null,
  database: Db = defaultDb
): RoomAccess {
  const symbol = roomTickerFor(rootId, database);
  if (!symbol) return { symbol: null, gated: false, entered: false, held: 0, priceSats: 0 };
  return {
    symbol,
    gated: true,
    entered: hasEntered(symbol, pubkey, database),
    held: heldUnits(symbol, pubkey, database),
    // ⚠ MINTED, NEVER HELD. Burning lowers held supply, so a price taken from it
    // would fall as the room filled — a room getting cheaper the more people
    // joined it. See `holdings.ts`.
    priceSats: mintPriceSats(mintedUnits(symbol, database)),
  };
}

/** Whether a key may post into this thread. `true` for anything that is not a room. */
export function mayEnter(rootId: number, pubkey: string | null, database: Db = defaultDb): boolean {
  const access = roomAccess(rootId, pubkey, database);
  return !access.gated || access.entered;
}

/**
 * Burn one ticket and record the membership it bought — the door, in one act.
 *
 * ⚠ ONE TRANSACTION, BOTH WRITES, AND THE ORDER MATTERS LESS THAN THE ATOMICITY.
 * A unit destroyed without the membership it paid for is somebody's money taken
 * for nothing; a membership granted without the burn is a free seat. SQLite gives
 * us both-or-neither, so take it.
 *
 * ⚠ IDEMPOTENT ON MEMBERSHIP, AND DELIBERATELY REFUSES A SECOND BURN. If the key
 * is already a member this returns success and destroys NOTHING — a double-tap on
 * the door, or a retry after a lost response, must not cost a second ticket.
 *
 * `burnTxid` is the on-chain evidence. It is accepted rather than derived because
 * the browser builds and broadcasts the burn; callers must have verified it before
 * calling. Null is allowed only for the grandfathered rows the migration writes.
 */
export function enterRoom(
  symbol: string,
  pubkey: string,
  opts: { burnTxid: string; paidSats: number },
  database: Db = defaultDb
): { ok: true; alreadyMember: boolean } | { ok: false; reason: "no_ticket" } {
  if (!pubkey) return { ok: false, reason: "no_ticket" };
  if (hasEntered(symbol, pubkey, database)) return { ok: true, alreadyMember: true };

  const run = database.transaction(() => {
    if (!burnUnits(symbol, pubkey, 1, database)) return false;
    database
      .prepare(
        `INSERT OR IGNORE INTO room_entries (symbol, pubkey, entry_kind, burn_txid, paid_sats)
         VALUES (?, ?, 'burn', ?, ?)`
      )
      .run(symbol, pubkey, opts.burnTxid, Math.max(0, Math.floor(opts.paidSats)));
    return true;
  });

  return run() ? { ok: true, alreadyMember: false } : { ok: false, reason: "no_ticket" };
}

/**
 * Admit the founder of a room — the one entry that burns nothing.
 *
 * ⚠ WHY THE FOUNDER IS AN EXCEPTION, having first been built as an ordinary burn
 * and then reverted. Burning the founding unit is more uniform and it was wrong,
 * for a reason that only showed up downstream: a founder whose single unit was
 * destroyed at their own door held nothing, so they vanished from their own
 * wallet, their room reported zero holders, and every "supply" counter on the site
 * — index, leaderboard, feed percentage — quietly changed meaning at the same
 * time. Ten tests failed, each of them correct about something different.
 *
 * ⚠ AND IT DOES NOT REOPEN THE HOLE BURNING WAS FOR. The exploit was one unit
 * admitting many people in sequence: buy, enter, sell on, repeat. A founder's
 * membership does not come from a unit at all — it comes from having created the
 * room — so it is not a thing that can be sold to the next person. The unit they
 * keep is ordinary tradeable stock, and whoever buys it still has to burn it to
 * get in. Every entry after the first is still one destroyed ticket.
 *
 * What the founder paid is the mint charge for claiming the word. That is the
 * price of the room existing, and it buys the seat.
 */
export function admitFounder(
  symbol: string,
  pubkey: string,
  paidSats: number,
  database: Db = defaultDb
): void {
  if (!pubkey || isRootTicker(symbol)) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO room_entries (symbol, pubkey, entry_kind, burn_txid, paid_sats)
       VALUES (?, ?, 'founder', NULL, ?)`
    )
    .run(symbol, pubkey, Math.max(0, Math.floor(paidSats)));
}
