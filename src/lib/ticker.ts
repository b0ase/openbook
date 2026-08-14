/**
 * Ticker parsing — `$Ticker` inside post content.
 *
 * ⚠ THIS PARSE RULE IS CONSENSUS-CRITICAL, NOT A UI DETAIL. A `$ticker` names a
 * thread, and under the token model (TOKENS.md) naming an unclaimed one is a
 * FOUNDING ACT that will eventually cost money and mint the genesis token. So
 * two properties matter more than catching every case:
 *
 *  1. **Ambiguity resolves toward NOT a ticker.** `$50`, `$1.50`, `US$20` and a
 *     bare `$` must never be tickers. Missing a ticker someone meant is a
 *     nuisance; treating a price as a claim is a transaction they did not ask
 *     for. TOKENS.md: "the ambiguous cases resolve toward NOT minting".
 *  2. **It must be reproducible from the post text alone**, because the post is
 *     the record. Anyone reading the chain must be able to derive the same
 *     tickers from the same content, without the database.
 *
 * Kept pure and dependency-free so the same function can back rendering,
 * registration, and any future chain indexer.
 */

/** Max characters after the `$`. Long enough for a phrase, short enough to read. */
export const TICKER_MAX_LENGTH = 16;

/**
 * A ticker is `$` + a LETTER + up to 15 more letters/digits.
 *
 * Leading letter is what excludes `$50` and `$1.50` — a price can never parse as
 * a ticker, which is the single most important exclusion here.
 *
 * The preceding character must be a start-of-string or a non-word character, so
 * `US$20` and `foo$bar` are not matches. Underscores and hyphens are excluded
 * from the body deliberately: they invite lookalike claims (`$Open_Book` vs
 * `$OpenBook`) on something that is supposed to be a durable name.
 */
const TICKER_PATTERN = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{0,15})\b/g;

/**
 * Canonical form used for identity and de-duplication: UPPERCASE.
 *
 * `$openbook`, `$OpenBook` and `$OPENBOOK` are the SAME ticker. Case-sensitive
 * tickers would let someone claim a visually identical name, which is the
 * impersonation attack the BSV-21 notes already warn about (`sym` is not
 * globally unique, so the app is what disambiguates).
 */
export function canonicalTicker(raw: string): string {
  return raw.replace(/^\$/, "").toUpperCase();
}

export interface TickerMatch {
  /** Canonical UPPERCASE symbol, no `$`. */
  symbol: string;
  /** Exactly as written, no `$` — so the post renders the author's casing. */
  raw: string;
  /** Index of the `$` in the source string. */
  start: number;
  /** Index one past the last character of the match. */
  end: number;
}

/**
 * Every ticker occurrence in `content`, in order, with positions — so a renderer
 * can slice the text without re-scanning and without a second regex that could
 * disagree with this one.
 */
export function findTickers(content: string): TickerMatch[] {
  const out: TickerMatch[] = [];
  // Fresh regex per call: /g patterns carry mutable lastIndex, and sharing one
  // across calls makes results depend on call order.
  const re = new RegExp(TICKER_PATTERN.source, "g");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    out.push({
      symbol: canonicalTicker(m[1]),
      raw: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
    m = re.exec(content);
  }
  return out;
}

/**
 * The DISTINCT tickers in a post, canonical and de-duplicated, preserving first
 * appearance order. This is what registration consumes — mentioning `$X` three
 * times in one post is one claim, not three.
 */
export function distinctTickers(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of findTickers(content)) {
    if (!seen.has(t.symbol)) {
      seen.add(t.symbol);
      out.push(t.symbol);
    }
  }
  return out;
}

/** Whether a canonical symbol is one this system would accept. */
export function isValidTicker(symbol: string): boolean {
  return /^[A-Z][A-Z0-9]{0,15}$/.test(symbol);
}
