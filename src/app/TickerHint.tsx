"use client";

import { useEffect, useState } from "react";
import { distinctTickers, titleCaseTicker } from "@/lib/ticker";
import { getTickerUsage, resolveTickers } from "./actions";

/**
 * Live indicator under the compose box for any `$Ticker` being typed.
 *
 * ⚠ THIS IS A DISCLOSURE, NOT DECORATION. Under the mint gesture (TOKENS.md),
 * naming an UNCLAIMED ticker is a paid founding act and naming a CLAIMED one is a
 * citation — the same keystrokes, two very different actions. This is what tells
 * them apart BEFORE the send button is pressed, which is what the button owes the
 * user. When minting is wired up, the price belongs here too.
 *
 * The percentage is a SATURATION gauge: 100% means this is the only use, a small
 * number means the name is well established. It is display only and must never
 * feed allocation — mentions are free, and anything free that confers value
 * destroys the anchor.
 *
 * Usage counts DISTINCT THREADS rather than raw mentions, so the figure cannot be
 * inflated by repeating a word.
 */

interface TickerState {
  symbol: string;
  claimed: boolean;
  threads: number;
}

export function TickerHint({ content }: { content: string }) {
  const [states, setStates] = useState<TickerState[]>([]);

  useEffect(() => {
    const symbols = distinctTickers(content).slice(0, 3);
    if (!symbols.length) {
      setStates([]);
      return;
    }
    let live = true;
    // Debounced: this fires on every keystroke, and a lookup per character would
    // be a query storm for a hint.
    const t = setTimeout(async () => {
      const [resolved, usage] = await Promise.all([
        resolveTickers(symbols),
        getTickerUsage(symbols),
      ]);
      if (!live) return;
      setStates(
        symbols.map((symbol) => ({
          symbol,
          claimed: Boolean(resolved[symbol]),
          threads: usage[symbol] ?? 0,
        }))
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [content]);

  if (!states.length) return null;

  return (
    <div className="mt-1.5 space-y-1">
      {states.map((s) => {
        // Include the post being written, so a brand-new name reads 100% rather
        // than 0% — the author is about to become its first use.
        const total = Math.max(1, s.threads + (s.claimed ? 0 : 1));
        const share = 100 / total;
        const pct =
          share >= 10
            ? share.toFixed(0)
            : share >= 1
              ? share.toFixed(1)
              : share.toFixed(share >= 0.1 ? 2 : 4);
        return (
          <div key={s.symbol} className="flex items-center gap-2 text-[11px] leading-tight">
            <span className="font-medium text-amber-400">${titleCaseTicker(s.symbol)}</span>
            <span
              className={`font-mono tabular-nums ${s.claimed ? "text-zinc-500" : "text-emerald-400"}`}
            >
              {pct}%
            </span>
            <span className="text-zinc-500">
              {s.claimed ? (
                <>
                  already claimed — you're linking to it
                  {s.threads > 1 && ` · used in ${s.threads} threads`}
                </>
              ) : (
                <span className="text-emerald-500/90">unclaimed — you'd be starting it</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
