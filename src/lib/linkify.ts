/**
 * Finding URLs and `$Ticker`s in post text so they can be rendered as links.
 *
 * Pure and dependency-free, like `ticker.ts`, so the renderer and any future
 * consumer agree on what a link is.
 *
 * ⚠ SCHEME ALLOWLIST, NOT A BLOCKLIST. Only `http://` and `https://` become
 * anchors. Post content is user-supplied and permanent, so a `javascript:` or
 * `data:` URL rendered as a clickable link would be stored XSS with an immutable
 * on-chain copy. Anything else stays inert text.
 */

import { findTickers, type TickerMatch } from "./ticker";

/** Trailing characters that are almost always sentence punctuation, not URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»]+$/;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

export interface UrlMatch {
  kind: "url";
  /** The href — always http(s), always trimmed of trailing punctuation. */
  url: string;
  start: number;
  end: number;
}

export interface TickerSegment extends TickerMatch {
  kind: "ticker";
}

export type Segment = UrlMatch | TickerSegment;

/**
 * Every URL in `content`, with positions.
 *
 * Trailing punctuation is trimmed because "see https://example.com." should link
 * to the site, not to a URL with a full stop glued on. An unbalanced closing
 * bracket is treated the same way — "(https://example.com)" is a URL in
 * parentheses far more often than a URL containing one.
 */
export function findUrls(content: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  const re = new RegExp(URL_PATTERN.source, "gi");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    let raw = m[0];
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    // Keep a closing bracket only when the URL actually opened one.
    raw = trimmed.length ? trimmed : raw;
    out.push({ kind: "url", url: raw, start: m.index, end: m.index + raw.length });
    m = re.exec(content);
  }
  return out;
}

/**
 * Whether `content` contains a URL at all.
 *
 * The cheap question the feed poll asks of every post on screen, to decide which
 * ones are still waiting on an unfurl. Uses the SAME pattern as `findUrls` — a
 * second, looser test here would have the client polling forever for previews
 * the server was never going to record.
 */
export function hasLink(content: string): boolean {
  return new RegExp(URL_PATTERN.source, "i").test(content);
}

/**
 * URLs and tickers together, ordered, non-overlapping — what a renderer walks.
 *
 * ⚠ URLS WIN OVER TICKERS ON OVERLAP. A path like `example.com/$OpenBooks` would
 * otherwise have a "ticker" carved out of the middle of the href, producing a
 * broken link and a claim nobody made. URLs are matched first and any ticker
 * falling inside one is discarded.
 */
export function findSegments(content: string): Segment[] {
  const urls = findUrls(content);
  const inUrl = (pos: number) => urls.some((u) => pos >= u.start && pos < u.end);
  const tickers: TickerSegment[] = findTickers(content)
    .filter((t) => !inUrl(t.start))
    .map((t) => ({ ...t, kind: "ticker" as const }));
  return [...urls, ...tickers].sort((a, b) => a.start - b.start);
}
