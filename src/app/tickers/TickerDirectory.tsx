"use client";

import { useEffect, useState } from "react";
import { formatShare } from "@/lib/share";
import { leaderboardHref, tickerHref, titleCaseTicker } from "@/lib/ticker";
import { searchTickers, type TickerHit } from "../actions";

/**
 * The searchable index.
 *
 * ⚠ RANKED BY SUPPLY, WHICH IS THE POINT. Supply is how many posts named a
 * ticker — how many people paid it attention — so the order here is the economic
 * signal rather than an inferred one. See DIRECTION.md: a ranking signal that
 * costs something to produce is the one thing conventional search no longer has.
 *
 * Server-rendered results are passed in as `initial` so the page is useful (and
 * indexable) before any JavaScript runs — an index that only exists after
 * hydration is invisible to exactly the crawlers this is meant to reach.
 */
export function TickerDirectory({ initial }: { initial: TickerHit[] }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TickerHit[]>(initial);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(initial);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    // Debounced: this fires per keystroke, and a query per character would be a
    // lookup storm for a list that changes slowly.
    const t = setTimeout(() => {
      void searchTickers(q)
        .then((r) => {
          if (live) setHits(r);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, initial]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="text-lg font-semibold tracking-tight">
        <span className="text-amber-400">$Open</span>Books index
      </h1>
      <p className="mt-1 text-[13px] text-zinc-500 leading-relaxed">
        Every name claimed on the board, heaviest first. Weight is how many posts named it &mdash;
        attention someone paid for, not a number we inferred.
      </p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search names…"
        aria-label="Search names"
        className="mt-4 block w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
      />

      {hits.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-600">
          {searching
            ? "Searching…"
            : query.trim()
              ? "No name matches that yet — post it and it's yours."
              : "No names claimed yet."}
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-zinc-800/60">
          {hits.map((h) => (
            // Two sibling links, not one wrapping the row: the name opens the
            // thread, the weight opens the holders it is made of. Nesting an
            // anchor inside an anchor is invalid HTML and the browser would
            // decide which one wins.
            <li key={h.symbol} className="flex items-baseline justify-between gap-3 py-3">
              <a
                href={tickerHref(h.path)}
                className="group flex min-w-0 flex-1 items-baseline justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium">
                    {h.path.slice(0, -1).map((seg) => (
                      <span key={seg} className="text-zinc-600">
                        ${titleCaseTicker(seg)}
                        <span className="text-zinc-700">/</span>
                      </span>
                    ))}
                    <span className="text-amber-400 group-hover:text-amber-300 transition-colors">
                      ${titleCaseTicker(h.symbol)}
                    </span>
                  </span>
                  {h.excerpt && (
                    <span className="mt-0.5 block truncate text-[12px] text-zinc-500">
                      {h.excerpt}
                    </span>
                  )}
                </span>
              </a>
              <a
                href={leaderboardHref(h.path)}
                title={`Who holds $${titleCaseTicker(h.symbol)}`}
                className="shrink-0 text-right hover:text-amber-400 transition-colors"
              >
                <span className="block font-mono text-sm tabular-nums text-white">{h.supply}</span>
                {/* One unit's share, the same figure the feed prints beside a
                    ticker — so the index and the feed can never disagree. */}
                <span className="block font-mono text-[10px] tabular-nums text-zinc-600">
                  {h.supply > 0 ? formatShare(1, h.supply) : "—"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-center text-[12px] text-zinc-600">
        <a href="/" className="hover:text-amber-400 transition-colors">
          &larr; Back to the board
        </a>
      </p>
    </div>
  );
}
