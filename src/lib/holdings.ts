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
 * ⚠ SUPPLY IS INVARIANT UNDER A TRANSFER. A sale moves units between holders and
 * never changes the total, so the sum here must always equal the sum over
 * mentions. That is asserted in the tests rather than assumed, because the day
 * it stops being true the market and the mint price start disagreeing.
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

/** Every unit of a symbol that exists — the denominator, and the mint price's input. */
export function totalUnits(symbol: string, database: Db = defaultDb): number {
  const row = database
    .prepare("SELECT COALESCE(SUM(units), 0) AS n FROM ticker_holdings WHERE symbol = ?")
    .get(symbol) as { n: number };
  return row?.n ?? 0;
}

/** Supply for several symbols at once — one indexed GROUP BY, not a query each. */
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
