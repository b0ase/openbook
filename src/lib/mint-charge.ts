import type Database from "better-sqlite3";
import { parseBuyCommand } from "./buy-command";
import { db as defaultDb } from "./db";
import { mintCostForRange, mintPriceSats, quoteMintSats } from "./mint-price";
import { isSealed } from "./room-crypto";
import { parseSendCommand } from "./send-command";
import { distinctTickers } from "./ticker";

type Db = ReturnType<typeof Database>;

/**
 * What a post actually owes for the tokens it mints.
 *
 * ⚠ THIS IS THE CHARGE, NOT A DISPLAY. `mint-price.ts` is the pure curve;
 * `getMintQuote` is what the composer shows while someone types. This is the
 * module both the CLIENT (which funds the transaction) and the SERVER (which
 * decides whether the transaction paid enough) read, and they must reach the
 * same number from the same inputs — a disagreement here rejects a post the
 * author has already broadcast and already paid the network fee for.
 *
 * ⚠ THE SYMBOLS ARE DERIVED FROM THE CONTENT, NEVER SUPPLIED. The client sends
 * the post's text; both sides run `distinctTickers` over it. If the client sent
 * a symbol list it could quote for `$Cheap` and post about `$Expensive`, and the
 * cheapest place to catch that is to never accept the list in the first place.
 * `recordTickerMentions` derives its mint set the same way, so what is charged
 * for and what is minted cannot diverge.
 */

/**
 * How many units of drift the server forgives when checking payment.
 *
 * ⚠ THE RACE THIS CLOSES, AND WHY IT LEANS THE WAY IT DOES. Supply rises every
 * time ANYONE names the same word, so the price a client is quoted can be stale
 * by the time its transaction reaches us — through no fault of the author, who
 * may simply have typed slowly. The two failure directions are not remotely
 * symmetric:
 *
 *  - Too STRICT: the post is refused AFTER broadcast. The author has spent the
 *    network fee and the platform payment, and gets nothing. That is taking
 *    someone's money for a service not rendered.
 *  - Too LOOSE: we under-collect by at most `SLACK × base` per word — about 565
 *    satoshis, well under a hundredth of a US cent.
 *
 * So this is deliberately generous. It is not an exploit surface worth closing
 * further: gaming it requires several other people to name your word in the
 * seconds between your quote and your broadcast, and wins a fraction of a penny.
 *
 * ⚠ FOR A BULK BUY THE FORGIVENESS SCALES WITH THE SIZE — `SLACK × units ×
 * base`, because a drift of five units shifts the price of EVERY unit in the
 * range. At the 10,000-unit ceiling that is ~5.6M sats (under a dollar at the
 * rate this was written), and it is the price of not rejecting a large purchase
 * because one stranger named the word first. A satoshi-capped band was
 * considered and rejected: it would cover only a hundredth of a unit of drift on
 * a thousand-unit buy, i.e. it would reject almost every bulk buy that raced.
 */
export const MINT_SLACK_UNITS = 5;

/**
 * Units EVER minted of each symbol — the curve's position, one indexed GROUP BY.
 *
 * ⚠ MENTIONS, NOT HOLDINGS, AND THAT IS A REVERSAL WITH A REASON. This read
 * `ticker_holdings` on the argument that "supply is what exists". Correct while
 * the only operation was a transfer, which preserves the total — the two tables
 * agreed, and the ledger was the better-defined source.
 *
 * Burning a ticket to enter a room is the first operation that makes them
 * diverge, and it exposed the inversion: a burn lowers held supply, so the next
 * entry would be priced CHEAPER, and a room would get cheaper the busier it got.
 * The curve's input is how far along the curve we are — units issued — which no
 * burn can walk back. `ticker_mentions` is append-only, so it is that number.
 *
 * See `holdings.ts` for the two counters, and DECISIONS.md "Entry BURNS the
 * ticket". Do not switch this back to holdings without reading both.
 */
export function mintedSupplies(symbols: readonly string[], database: Db = defaultDb) {
  const supply = new Map<string, number>();
  const wanted = [...new Set(symbols)];
  if (!wanted.length) return supply;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, COALESCE(SUM(units), 0) AS n FROM ticker_mentions
        WHERE symbol IN (${placeholders}) GROUP BY symbol`
    )
    .all(...wanted) as Array<{ symbol: string; n: number }>;
  for (const r of rows) supply.set(r.symbol, r.n);
  return supply;
}

/**
 * What this text costs to mint right now — the number the author is charged.
 *
 * ⚠ EVERY DISTINCT TICKER, NOT THE FIRST FEW. `getMintQuote` caps its list
 * because it feeds a hint under the compose box that shows three of them; a cap
 * HERE would mint tokens nobody paid for. The sum is over the same set
 * `recordTickerMentions` inserts.
 */
export function mintChargeSats(content: string, database: Db = defaultDb): number {
  /**
   * ⚠ A SEND MINTS NOTHING, SO IT COSTS NOTHING TO MINT — checked FIRST, before
   * anything else looks at the text.
   *
   * `/send 1 $Occam @Bob` names a ticker, so falling through would charge the
   * sender the current mint price to give away a ticket they ALREADY OWN, and
   * would mint a fresh unit on top of the one being transferred. Units move here;
   * supply does not change. The send is still paid for — it is a post, and posting
   * is paid — but the mint charge is zero because nothing is minted.
   */
  if (parseSendCommand(content)) return 0;

  /**
   * ⚠ A SEALED POST MINTS NOTHING, AND IT IS SAID HERE RATHER THAN LEFT TO
   * EMERGE. `distinctTickers` finds no `$Word` in an encrypted envelope, so
   * this already returned 0 by accident — an invariant nothing states and
   * nothing protects. If a base64 body ever happened to contain something that
   * parsed as a ticker, an author would be charged for minting a word they
   * never named, in a room nobody can read to check.
   *
   * The RULE (owner's decision, 2026-08-20) is that naming a word inside a
   * private room mints nothing and costs nothing to mint. The alternative was
   * to let the client declare which symbols a sealed post contained, and
   * `CLAUDE.md` is explicit that symbols are derived from content and never
   * supplied — a claim the server cannot check is not a claim it should price.
   * A private claim on a public namespace is odd anyway.
   */
  if (isSealed(content)) return 0;

  // ⚠ A BUY IS PRICED FIRST AND ON ITS OWN. `/buy 1000 $Memeplex` names a
  // ticker, so falling through to the ordinary path would charge for ONE unit
  // and mint a thousand. The command IS the whole message (`parseBuyCommand` is
  // anchored), so there is nothing else in it to price.
  const buy = parseBuyCommand(content);
  if (buy) {
    const supply = mintedSupplies([buy.symbol], database);
    return mintCostForRange(supply.get(buy.symbol) ?? 0, buy.units);
  }

  const symbols = distinctTickers(content);
  if (!symbols.length) return 0;
  const supply = mintedSupplies(symbols, database);
  return quoteMintSats(symbols, (s) => supply.get(s) ?? 0);
}

/**
 * The least the mint may be paid for a post to be accepted.
 *
 * The same sum as `mintChargeSats` but priced at the supply as it stood up to
 * `MINT_SLACK_UNITS` units ago, so a client that quoted a moment earlier still
 * clears the bar. Never negative: a word with fewer units than the slack is
 * priced from zero, i.e. at base.
 */
export function mintFloorSats(content: string, database: Db = defaultDb): number {
  // Same order as the charge, and it has to be — including the send, which owes
  // nothing. A floor above zero here would REJECT every send after broadcast,
  // for underpaying a mint that never happened.
  if (parseSendCommand(content)) return 0;

  // Same rule as the charge, and it has to be here too: a floor above zero
  // would REJECT every sealed post after broadcast, for underpaying a mint
  // that never happened.
  if (isSealed(content)) return 0;

  // Same order as the charge, and it has to be: a buy checked as an ordinary
  // mention would accept one unit's payment for a thousand units of stock.
  const buy = parseBuyCommand(content);
  if (buy) {
    const supply = mintedSupplies([buy.symbol], database);
    const from = Math.max(0, (supply.get(buy.symbol) ?? 0) - MINT_SLACK_UNITS);
    return mintCostForRange(from, buy.units);
  }

  const symbols = distinctTickers(content);
  if (!symbols.length) return 0;
  const supply = mintedSupplies(symbols, database);
  return symbols.reduce(
    (total, s) => total + mintPriceSats(Math.max(0, (supply.get(s) ?? 0) - MINT_SLACK_UNITS)),
    0
  );
}
