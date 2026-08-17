import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";
import { unitsHeld } from "./holdings";

type Db = ReturnType<typeof Database>;

/**
 * The secondary market: offers to sell units, and what is left of them.
 *
 * ⚠ THIS IS A LEDGER MARKET, NOT AN ON-CHAIN SWAP, AND THE DIFFERENCE MATTERS.
 * A unit is a row in `ticker_holdings`, not an ordinal anyone can move
 * themselves — so a sale is: the buyer pays the seller PEER TO PEER in a
 * transaction we never touch, and we then move the ledger against that verified
 * payment. Money is never held by the platform. What the platform IS trusted for
 * is applying the transfer once the payment is real, and that is a genuine trust
 * assumption which the docs should keep stating rather than dressing up as
 * trustless. A true non-custodial swap needs the units themselves on chain
 * (OrdLock — researched in TOKENS.md, not built).
 *
 * ⚠ AVAILABILITY IS CHECKED TWICE, AND THAT IS NOT BELT AND BRACES. A seller can
 * list ten units and then sell nine of them elsewhere, or spend them on a room
 * they leave. The check at LIST time keeps the book honest; the check at FILL
 * time is the one that protects the buyer, because holdings move in between.
 */

export interface Listing {
  id: number;
  symbol: string;
  sellerPubkey: string;
  sellerAddress: string;
  /** Units still available: what was listed, minus what has sold. */
  unitsLeft: number;
  priceSats: number;
}

/** The most units one offer may carry — the same typo guard `/buy` uses. */
export const MAX_LISTING_UNITS = 10_000;

/** Units this key has promised to other people and not yet delivered. */
export function unitsCommitted(symbol: string, pubkey: string, database: Db = defaultDb): number {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(units - units_sold), 0) AS n FROM listings
        WHERE symbol = ? AND seller_pubkey = ? AND cancelled_at IS NULL AND units > units_sold`
    )
    .get(symbol, pubkey) as { n: number };
  return row?.n ?? 0;
}

/**
 * Units this key could list right now — what they hold, minus what is already
 * on offer.
 *
 * Without the subtraction somebody could list the same ten units four times and
 * take four payments for them, and only the fourth buyer would find out.
 */
export function unitsListable(symbol: string, pubkey: string, database: Db = defaultDb): number {
  return Math.max(
    0,
    unitsHeld(symbol, pubkey, database) - unitsCommitted(symbol, pubkey, database)
  );
}

/** Open offers for a symbol, cheapest first — the ask side of the book. */
export function openListings(symbol: string, database: Db = defaultDb): Listing[] {
  return (
    database
      .prepare(
        `SELECT id, symbol, seller_pubkey, seller_address, units - units_sold AS units_left,
                price_sats
           FROM listings
          WHERE symbol = ? AND cancelled_at IS NULL AND units > units_sold
          ORDER BY price_sats ASC, id ASC
          LIMIT 50`
      )
      .all(symbol) as Array<{
      id: number;
      symbol: string;
      seller_pubkey: string;
      seller_address: string;
      units_left: number;
      price_sats: number;
    }>
  ).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    sellerPubkey: r.seller_pubkey,
    sellerAddress: r.seller_address,
    unitsLeft: r.units_left,
    priceSats: r.price_sats,
  }));
}

/**
 * The cheapest ask per symbol — what the market page and a room's door show
 * beside the mint price.
 *
 * ⚠ THE POINT OF THE WHOLE FEATURE IS THIS NUMBER BEING LOWER. The mint price is
 * a ceiling: nobody rationally pays more second-hand than a fresh unit costs. So
 * an ask below it is the market doing its job, and a buyer who is not shown it
 * is being overcharged by the interface.
 */
export function cheapestAsks(
  symbols: readonly string[],
  database: Db = defaultDb
): Map<string, number> {
  const out = new Map<string, number>();
  const wanted = [...new Set(symbols)];
  if (!wanted.length) return out;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, MIN(price_sats) AS ask FROM listings
        WHERE symbol IN (${placeholders}) AND cancelled_at IS NULL AND units > units_sold
        GROUP BY symbol`
    )
    .all(...wanted) as Array<{ symbol: string; ask: number }>;
  for (const r of rows) out.set(r.symbol, r.ask);
  return out;
}

/** A single offer, or null if it is gone, cancelled or sold out. */
export function findOpenListing(id: number, database: Db = defaultDb): Listing | null {
  const r = database
    .prepare(
      `SELECT id, symbol, seller_pubkey, seller_address, units - units_sold AS units_left,
              price_sats
         FROM listings
        WHERE id = ? AND cancelled_at IS NULL AND units > units_sold`
    )
    .get(id) as
    | {
        id: number;
        symbol: string;
        seller_pubkey: string;
        seller_address: string;
        units_left: number;
        price_sats: number;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    symbol: r.symbol,
    sellerPubkey: r.seller_pubkey,
    sellerAddress: r.seller_address,
    unitsLeft: r.units_left,
    priceSats: r.price_sats,
  };
}
