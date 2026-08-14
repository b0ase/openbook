"use client";

import { findTickers } from "@/lib/ticker";

/**
 * Post body text with `$Ticker` rendered as a link to the thread it names.
 *
 * ⚠ SPLIT ON `findTickers`' OFFSETS, NEVER ON A SECOND REGEX. The parse rule is
 * consensus-critical (see lib/ticker.ts) — a renderer with its own pattern would
 * eventually disagree with the one that decides what gets CLAIMED, and the
 * visible link would stop matching the recorded owner.
 *
 * Every ticker in an existing post resolves, because registration happens at post
 * time: a `$X` here was claimed either by this post or by an earlier one. The
 * exception is posts written before the registry existed, which is why the click
 * handler tolerates an unresolved symbol instead of assuming.
 */
export function PostText({
  content,
  onOpenTicker,
}: {
  content: string;
  onOpenTicker?: (symbol: string) => void;
}) {
  const matches = findTickers(content);
  if (matches.length === 0 || !onOpenTicker) return <>{content}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  matches.forEach((m, i) => {
    if (m.start > cursor) parts.push(content.slice(cursor, m.start));
    parts.push(
      <button
        // Index is stable here: the list is derived from immutable post content
        // and is never reordered or filtered.
        key={`${m.symbol}-${i}`}
        type="button"
        onClick={(e) => {
          // The whole post row is not a link, but a parent may become one —
          // opening a thread should not also trigger anything above it.
          e.stopPropagation();
          onOpenTicker(m.symbol);
        }}
        className="text-amber-400 hover:text-amber-300 font-medium transition-colors underline-offset-2 hover:underline"
        title={`Open the $${m.raw} thread`}
      >
        ${m.raw}
      </button>
    );
    cursor = m.end;
  });

  if (cursor < content.length) parts.push(content.slice(cursor));
  return <>{parts}</>;
}
