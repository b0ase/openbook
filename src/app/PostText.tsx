"use client";

import { findSegments } from "@/lib/linkify";

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
export function PostText({
  content,
  onOpenTicker,
}: {
  content: string;
  onOpenTicker?: (symbol: string) => void;
}) {
  const segments = findSegments(content);
  if (segments.length === 0) return <>{content}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

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
