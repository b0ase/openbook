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
 * `$OpenBooks`) on something that is supposed to be a durable name.
 */
const TICKER_PATTERN = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{0,15})\b/g;

/**
 * Canonical form used for identity and de-duplication: UPPERCASE.
 *
 * `$openbook`, `$OpenBooks` and `$OPENBOOK` are the SAME ticker. Case-sensitive
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

/**
 * The root token. Every ticker claimed outside another ticker's thread parents to
 * this, so the whole board is one tree rather than a scattering of unrelated
 * names — and the main feed is simply this token's thread.
 */
export const ROOT_TICKER = "OPENBOOKS";

/**
 * The root's previous name, kept so old links keep working.
 *
 * The board was `$OpenBook` until 2026-08-14, when it took the plural to match
 * `openbooks.space`. Renaming the root is CHEAP here and expensive elsewhere,
 * for one reason worth knowing: a ticker URL resolves by its LAST segment only
 * (`Feed.tsx` → `parseTickerPath(...).at(-1)`), so `/$openbook/$test` already
 * opens `$Test` without consulting the ancestors at all. Only the breadcrumb
 * changes.
 *
 * `/$openbook` on its own is the one case that needs this constant: it used to
 * mean "the root, i.e. the main feed", and without recognising the old name it
 * would fall through to "unknown ticker".
 */
export const LEGACY_ROOT_TICKER = "OPENBOOK";

/** True for either spelling of the root — use this, never `=== ROOT_TICKER`. */
export function isRootTicker(symbol: string): boolean {
  return symbol === ROOT_TICKER || symbol === LEGACY_ROOT_TICKER;
}

/**
 * The root token's address is the bare site — `openbooks.space`, not
 * `openbooks.space/$openbooks`.
 *
 * ⚠ THIS IS THE ONE URL PEOPLE TYPE, so it is worth stating why the root gets a
 * shorter address than every other ticker. The main feed IS the root's thread;
 * they are the same view, not two views that happen to look alike. Given two
 * URLs for one thing, the one on the business card wins — nobody shares
 * `/$openbooks`, and a visitor who typed the domain should not watch the address
 * bar grow a path they never asked for.
 *
 * So: `/` is the root, `/$whatever` is every other thread. `/$openbooks` (and the
 * pre-plural `/$openbook`) stay VALID and redirect here — old links, and links
 * from before this rule existed, must not break.
 */
export const ROOT_HREF = "/";

/** Render a claim path for display: `["OPENBOOK","TEST"]` → `$OpenBooks/$Test`. */
export function formatTickerPath(path: string[], display?: Record<string, string>): string {
  return path.map((s) => `$${display?.[s] ?? titleCaseTicker(s)}`).join("/");
}

/**
 * Canonical symbols are UPPERCASE, which shouts in a header. This restores a
 * readable form for display ONLY — identity is always the uppercase symbol.
 */
export function titleCaseTicker(symbol: string): string {
  return symbol.charAt(0) + symbol.slice(1).toLowerCase();
}

/** URL path segment for a ticker: `OPENBOOK` → `$openbook`. */
export function tickerSlug(symbol: string): string {
  return `$${symbol.toLowerCase()}`;
}

/**
 * The address of the thread a claim path names: `["OPENBOOKS","TEST"]` →
 * `/$openbooks/$test`, and the root on its own → `/` (see `ROOT_HREF`).
 *
 * Keyed on the LAST segment because that is the only one that decides which
 * thread opens (`parseTickerPath(...).at(-1)`) — an ancestor named `$OpenBooks`
 * is breadcrumb context and stays in the URL.
 *
 * Every link to a thread goes through here so no caller can mint a second
 * address for the root by hand; that is exactly how `/$openbooks` used to end up
 * in the address bar after closing a thread.
 */
export function tickerHref(path: string[]): string {
  const leaf = path.at(-1);
  if (!leaf || isRootTicker(leaf)) return ROOT_HREF;
  return `/${path.map(tickerSlug).join("/")}`;
}

/** Parse `/$openbook/$test` → `["OPENBOOK","TEST"]`. Non-ticker segments are ignored. */
export function parseTickerPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((seg) => seg.startsWith("$"))
    .map((seg) => canonicalTicker(decodeURIComponent(seg)))
    .filter(isValidTicker);
}
