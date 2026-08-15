"use client";

import { findSegments } from "@/lib/linkify";
import { formatShare } from "@/lib/share";

/**
 * Post body text with URLs as live links and `$Ticker`s as links to the thread
 * they name.
 *
 * ⚠ SPLIT ON THE SHARED MATCHER'S OFFSETS, NEVER ON A SECOND REGEX. The ticker
 * parse rule is consensus-critical (see lib/ticker.ts) — a renderer with its own
 * pattern would eventually disagree with the one that decides what gets CLAIMED,
 * and the visible link would stop matching the recorded owner.
 *
 * Links open in a new tab with `rel="noopener noreferrer"`: post content is
 * user-supplied and permanent, so a link must never be able to reach back into
 * this page via `window.opener`. `findSegments` only ever yields http(s) URLs,
 * so `javascript:` and `data:` can never become an href.
 */
/**
 * Which ticker mentions in a post are allowed to print a share figure.
 *
 * ⚠ THE FIGURE SITS INSIDE A SENTENCE SOMEBODY WROTE, so every character of it
 * is a tax on reading them, and it earns its place only where it says something:
 *
 * - **Not at 100%.** A sole holding is what EVERY new name is, so the figure
 *   carries no information while still breaking the prose — `A $ticker (100%)
 *   contains lots of things. In business, a $ticker (100%) is the shorthand…`.
 *   The wallet already reports those, as `1-of-1`.
 * - **Not twice.** Supply is counted per POST (one unit per post, enforced by a
 *   partial unique index), so a name written three times in one post necessarily
 *   prints the SAME number three times. Once, at its first mention.
 *
 * Returns start offsets, which are unique per post, so the renderer looks up a
 * mention rather than re-deriving this while building JSX — React Compiler is
 * enabled here, and a render depending on side effects landing in source order
 * is precisely what it is free to rearrange.
 */
export function figuredOffsets(
  segments: ReturnType<typeof findSegments>,
  tickerSupply?: Record<string, number>
): Set<number> {
  const figured = new Set<number>();
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seg.kind !== "ticker" || seen.has(seg.symbol)) continue;
    seen.add(seg.symbol);
    const tokens = tickerSupply?.[seg.symbol];
    if (tokens && tokens > 1) figured.add(seg.start);
  }
  return figured;
}

export function PostText({
  content,
  onOpenTicker,
  tickerSupply,
}: {
  content: string;
  onOpenTicker?: (symbol: string) => void;
  /**
   * Tokens issued per ticker, keyed by CANONICAL symbol.
   *
   * Passed down rather than fetched here: a feed can hold a hundred posts and
   * several may name the same token, so a lookup per mention would turn
   * scrolling into a query storm for a figure shown in brackets. The feed asks
   * once for everything on screen and refreshes it on the poll it already runs.
   *
   * A symbol that is absent renders with no figure — an unclaimed name has no
   * supply, and inventing a 0% would read as "worthless" rather than "not a
   * token yet".
   */
  tickerSupply?: Record<string, number>;
}) {
  const segments = findSegments(content);
  if (segments.length === 0) return <>{content}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  const figured = figuredOffsets(segments, tickerSupply);

  // Keyed on the segment's offset in the content, not its array index: offsets
  // are unique and stable for a given post, so editing nothing keeps the same
  // keys while an index would renumber every node after any insertion.
  segments.forEach((seg) => {
    if (seg.start > cursor) parts.push(content.slice(cursor, seg.start));

    if (seg.kind === "url") {
      parts.push(
        <a
          key={`u-${seg.start}`}
          href={seg.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-sky-400 hover:text-sky-300 transition-colors underline underline-offset-2 break-all"
        >
          {seg.url}
        </a>
      );
    } else if (onOpenTicker) {
      parts.push(
        <button
          key={`t-${seg.start}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTicker(seg.symbol);
          }}
          className="text-amber-400 hover:text-amber-300 font-medium transition-colors underline-offset-2 hover:underline"
          title={`Open the $${seg.raw} thread`}
        >
          ${seg.raw}
          {/* One post's share of that token's supply — the figure that makes
              dilution visible at the moment it happens rather than in a wallet
              screen later.

              ⚠ ONLY WHERE IT CARRIES INFORMATION, because this sits INSIDE a
              sentence somebody wrote and every character of it is a tax on
              reading them.

              - Not at 100%: a sole holding is what EVERY new name is, so the
                figure says nothing while breaking the prose. The wallet already
                reports those as `1-of-1`.
              - Not twice: supply is counted per POST, so a word named three
                times in one post necessarily prints the same number three
                times. Once, at its first mention. */}
          {figured.has(seg.start) && (
            <span className="text-amber-400/60 font-normal tabular-nums">
              {" "}
              ({formatShare(1, tickerSupply?.[seg.symbol] ?? 1)})
            </span>
          )}
        </button>
      );
    } else {
      // No handler wired — render the ticker as plain text rather than a control
      // that does nothing.
      parts.push(`$${seg.raw}`);
    }

    cursor = seg.end;
  });

  if (cursor < content.length) parts.push(content.slice(cursor));
  return <>{parts}</>;
}
