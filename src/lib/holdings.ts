import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";

type Db = ReturnType<typeof Database>;

/**
 * Who owns which units, right now.
 *
 * ⚠ THE SINGLE SOURCE OF OWNERSHIP. `ticker_mentions` records that a post NAMED
 * a word and how many units that minted — history, and permanent. This records
 * who holds them TODAY, which changes the moment a unit is sold. Every "how many
 * units exist", "how many does this person hold" and "who are the holders" query
 * reads here; every "how many posts said this word" query still reads mentions.
 * Mixing the two is how a sale would either vanish or rewrite history.
 *
 * ⚠ SUPPLY IS INVARIANT UNDER A TRANSFER — AND NOT UNDER A BURN, WHICH IS WHY
 * THERE ARE NOW TWO COUNTERS. A sale moves units between holders and never
 * changes the total, so under transfer-only this sum and the sum over mentions
 * agreed and either could price a mint. Burning a ticket to enter a room destroys
 * a unit, so they diverge permanently:
 *
 *   `totalUnits`  — units held TODAY. Falls when a ticket is burned. The
 *                   denominator for "who owns what", and for how many unused
 *                   tickets are still in circulation.
 *   `mintedUnits` — units EVER minted. Monotonic. **The only correct input to a
 *                   price.**
 *
 * ⚠ GET THIS BACKWARDS AND THE ECONOMICS INVERT, SILENTLY. Pricing from
 * `totalUnits` means every burn makes the next entry CHEAPER — a room gets less
 * expensive to join the more people join it, which is the opposite of what the
 * curve is for. That was live for the few hours between the room gate shipping
 * and burning being decided. The covenant never had the bug (`minted = max -
 * supply`, and supply only falls on mint), so this is the app catching up to the
 * contract.
 *
 * The unattributed pile is `pubkey = ''` — genesis posts carry no key, so their
 * units belong to nobody. A NULL would be uncomparable in the primary key
 * (SQLite treats NULLs as distinct) and would let the same pile accumulate
 * duplicate rows.
 */

/** Units this key holds of a symbol. */
export function unitsHeld(symbol: string, pubkey: string | null, database: Db = defaultDb): number {
  if (!pubkey) return 0;
  const row = database
    .prepare("SELECT units FROM ticker_holdings WHERE symbol = ? AND pubkey = ?")
    .get(symbol, pubkey) as { units: number } | undefined;
  return row?.units ?? 0;
}

/**
 * Units of a symbol held today — CIRCULATING, not issued.
 *
 * ⚠ NOT A PRICE INPUT. Burning a ticket lowers this, so a price derived from it
 * falls as a room fills. Use `mintedUnits`. This is the right number for "how
 * many unused tickets are out there" and for ownership percentages.
 */
export function totalUnits(symbol: string, database: Db = defaultDb): number {
  const row = database
    .prepare("SELECT COALESCE(SUM(units), 0) AS n FROM ticker_holdings WHERE symbol = ?")
    .get(symbol) as { n: number };
  return row?.n ?? 0;
}

/**
 * Units of a symbol EVER minted — the monotonic counter, and the only correct
 * input to a price.
 *
 * ⚠ READS `ticker_mentions`, WHICH IS APPEND-ONLY BY DESIGN. Nothing in the app
 * deletes or updates a mention row (verified, and it is the reason this counter
 * can be trusted): a mention records that a post named a word and how many units
 * that minted, permanently. Burning destroys a HOLDING; it cannot unmint history.
 *
 * ⚠ SO IT IS ALSO THE COUNT THE COVENANT AGREES WITH. On chain, `minted = max -
 * supply` and supply only ever falls on a mint — a burn does not return units to
 * the contract. This query is that same quantity, computed from our side.
 */
export function mintedUnits(symbol: string, database: Db = defaultDb): number {
  const row = database
    .prepare("SELECT COALESCE(SUM(units), 0) AS n FROM ticker_mentions WHERE symbol = ?")
    .get(symbol) as { n: number };
  return row?.n ?? 0;
}

/** Held units for several symbols at once — one indexed GROUP BY, not a query each. */
export function unitsBySymbol(
  symbols: readonly string[],
  database: Db = defaultDb
): Map<string, number> {
  const out = new Map<string, number>();
  const wanted = [...new Set(symbols)];
  if (!wanted.length) return out;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, COALESCE(SUM(units), 0) AS n FROM ticker_holdings
        WHERE symbol IN (${placeholders}) GROUP BY symbol`
    )
    .all(...wanted) as Array<{ symbol: string; n: number }>;
  for (const r of rows) out.set(r.symbol, r.n);
  return out;
}

/** Ever-minted units for several symbols at once — the batched `mintedUnits`. */
export function mintedBySymbol(
  symbols: readonly string[],
  database: Db = defaultDb
): Map<string, number> {
  const out = new Map<string, number>();
  const wanted = [...new Set(symbols)];
  if (!wanted.length) return out;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, COALESCE(SUM(units), 0) AS n FROM ticker_mentions
        WHERE symbol IN (${placeholders}) GROUP BY symbol`
    )
    .all(...wanted) as Array<{ symbol: string; n: number }>;
  for (const r of rows) out.set(r.symbol, r.n);
  return out;
}

/**
 * Destroy units held by a key — the door tearing a ticket.
 *
 * ⚠ NOT A TRANSFER TO A VOID ADDRESS. A burn has no recipient, so unlike
 * `transferUnits` there is no credit to balance the debit: this is the one
 * operation that legitimately reduces total supply, and `mintedUnits` is what
 * keeps the price from noticing.
 *
 * ⚠ REFUSES RATHER THAN GOING NEGATIVE, and the caller must treat `false` as a
 * failed entry. Wrap it in the transaction that also records the room entry — a
 * unit destroyed without the membership it bought is somebody's money taken for
 * nothing.
 */
export function burnUnits(
  symbol: string,
  pubkey: string,
  units: number,
  database: Db = defaultDb
): boolean {
  const n = Math.floor(units);
  if (n < 1 || !pubkey) return false;
  if (unitsHeld(symbol, pubkey, database) < n) return false;
  database
    .prepare("UPDATE ticker_holdings SET units = units - ? WHERE symbol = ? AND pubkey = ?")
    .run(n, symbol, pubkey);
  return true;
}

/**
 * Credit units to a holder.
 *
 * ⚠ NOT A SETTER. `ON CONFLICT … units = units + excluded.units` is what makes
 * a second mint of the same word by the same person add rather than replace —
 * writing the new figure would silently destroy everything they already held.
 */
export function creditUnits(
  symbol: string,
  pubkey: string | null,
  units: number,
  database: Db = defaultDb
): void {
  const n = Math.max(0, Math.floor(units));
  if (n === 0) return;
  database
    .prepare(
      `INSERT INTO ticker_holdings (symbol, pubkey, units) VALUES (?, ?, ?)
       ON CONFLICT(symbol, pubkey) DO UPDATE SET units = units + excluded.units`
    )
    .run(symbol, pubkey ?? "", n);
}

/**
 * Move units between holders.
 *
 * ⚠ REFUSES RATHER THAN GOING NEGATIVE, and the caller must treat `false` as a
 * failed sale. The `units >= 0` CHECK on the table is the backstop, but a
 * constraint violation mid-transfer is an exception in the middle of a payment
 * flow; an explicit check is an answer the caller can act on.
 *
 * The caller wraps this in the transaction that also records the fill — a debit
 * without a matching credit is somebody's property destroyed.
 */
export function transferUnits(
  symbol: string,
  fromPubkey: string,
  toPubkey: string,
  units: number,
  database: Db = defaultDb
): boolean {
  const n = Math.floor(units);
  if (n < 1) return false;
  if (unitsHeld(symbol, fromPubkey, database) < n) return false;
  database
    .prepare("UPDATE ticker_holdings SET units = units - ? WHERE symbol = ? AND pubkey = ?")
    .run(n, symbol, fromPubkey);
  creditUnits(symbol, toPubkey, n, database);
  return true;
}
