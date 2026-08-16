import { canonicalTicker, isValidTicker } from "./ticker";

/**
 * `/buy 1000 $Memeplex` — acquiring units of a word without writing a post about
 * it.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Until now the only way to hold a unit was to NAME
 * the word in a post, one unit at a time. That makes accumulating a position in
 * a word require writing a thousand posts about it, which is spam dressed as
 * conviction. The owner's own intent — *"I WILL put $5 towards BUYING the mint
 * of 10,000 of the most valuable words"* — has no expression in that model.
 *
 * ⚠ EACH UNIT IS PRICED SEPARATELY, WALKING UP THE CURVE. That is the whole
 * point and not an implementation detail: buying N units costs
 * `mintCostForRange`, which is QUADRATIC, so the buyer's average price is about
 * half the price they leave behind them. Two things follow, both intended:
 *
 *  - **It pushes the ceiling up for the next buyer.** A large buy raises what
 *    everybody after them pays to mint a fresh unit.
 *  - **It creates a market maker.** Having paid the average, the buyer can
 *    resell below the new mint price and above their own cost. Nobody appoints
 *    them; the geometry of the curve does it.
 *
 * The risk worth naming out loud, since nothing here prevents it: somebody
 * buying deep controls what entry costs for a word. They paid quadratically for
 * the privilege, and anyone can still mint fresh at the current price, which
 * bounds the damage — but "who can corner a word" is a real question and this
 * is where the answer lives if it ever needs one.
 *
 * Pure and dependency-free, like `ticker.ts`: the compose box, the server action
 * and the price all have to read the same command out of the same text.
 */

export interface BuyCommand {
  /** Canonical (UPPERCASE) symbol — the same form a claim uses. */
  symbol: string;
  units: number;
}

/**
 * The most units one command may buy.
 *
 * ⚠ NOT A PRICE CONTROL — the curve is already quadratic, so a big buy is
 * self-limiting in cost. This is a TYPO GUARD. `/buy 1000000 $X` is six
 * keystrokes away from `/buy 100000 $X` and would quote a number nobody can pay,
 * and the failure would arrive as an incomprehensible funding error. Refusing a
 * clearly-unintended size up front is kinder than pricing it.
 */
export const MAX_BUY_UNITS = 10_000;

/**
 * Parse a compose-box value as a buy, or null if it is not one.
 *
 * ⚠ STRICT, FOR THE REASON `parseSlashCommand` IS STRICT: posts are permanent
 * and this one SPENDS MONEY. A near-miss must fall through to being an ordinary
 * post rather than being guessed at — `/buy some stuff` is a sentence, and
 * `/buy 10 $A $B` is ambiguous about what is being bought, so neither parses.
 *
 * The count is optional and defaults to one, because `/buy $Memeplex` is the
 * obvious way to ask for a single unit and refusing it would be pedantry.
 * Separators are allowed in the count (`1,000`, `1_000`) since a four-digit
 * number is exactly where people type them.
 */
export function parseBuyCommand(raw: string): BuyCommand | null {
  const text = raw.trim();
  // Anchored at both ends: a buy command is the WHOLE message. Trailing prose
  // would be text nobody stores, on a board whose promise is that what you
  // wrote is kept.
  const m = /^\/buy\s+(?:([\d,_]+)\s+)?\$([A-Za-z][A-Za-z0-9]*)$/i.exec(text);
  if (!m) return null;

  const symbol = canonicalTicker(`$${m[2]}`);
  if (!isValidTicker(symbol)) return null;

  const rawCount = m[1];
  if (rawCount === undefined) return { symbol, units: 1 };

  const digits = rawCount.replace(/[,_]/g, "");
  // A separator-only count (`/buy ,,, $X`) leaves nothing to parse.
  if (digits === "") return null;
  const units = Number(digits);
  if (!Number.isSafeInteger(units) || units < 1 || units > MAX_BUY_UNITS) return null;

  return { symbol, units };
}

/** Whether a compose-box value would buy units rather than post. */
export function isBuyCommand(raw: string): boolean {
  return parseBuyCommand(raw) !== null;
}

/**
 * The text a buy is recorded as, on chain and in the feed.
 *
 * ⚠ CANONICAL, AND THE SERVER RE-DERIVES FROM IT. What the buyer signs, what is
 * inscribed, what the feed shows and what the price is computed from are all
 * this one string — so a client cannot be quoted for one word and buy another,
 * and the record on chain says exactly what was bought. Round-trips through
 * `parseBuyCommand`, which is what the server calls on the way back in.
 */
export function buyCommandText(cmd: BuyCommand): string {
  return `/buy ${cmd.units} $${cmd.symbol}`;
}
