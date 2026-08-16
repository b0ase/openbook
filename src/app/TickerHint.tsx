"use client";

import { useEffect, useState } from "react";
import { formatShare } from "@/lib/share";
import { distinctTickers, titleCaseTicker } from "@/lib/ticker";
import { getMintQuote, getTickerUsage, isReservedTicker, resolveTickers } from "./actions";

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
  /** Cost to mint this word's next unit, in satoshis. Display only — see `getMintQuote`. */
  priceSats?: number;
  symbol: string;
  claimed: boolean;
  /**
   * Held open by the operator, so naming it claims nothing.
   *
   * ⚠ A THIRD STATE, NOT A SHADE OF "UNCLAIMED". A reserved name is unclaimed in
   * the database and unclaimable in fact, and the hint used to report only the
   * first half: typing `$OpenBook` — reserved because it names the REPOSITORY
   * token — was answered with "100% · unclaimed — you'd be starting it". The one
   * disclosure that exists to say what pressing send will do said the opposite
   * of what it does.
   */
  reserved: boolean;
  threads: number;
}

/**
 * The denominator the hint's percentage is drawn against.
 *
 * ⚠ AN UNCLAIMED NAME IS ALWAYS 100%, WHATEVER ELSE MENTIONS IT. Counting other
 * threads produced `$Ticker · 50% · unclaimed — you'd be starting it`, which
 * says two opposite things at once: you cannot be starting something you already
 * hold half of. Mentions are free and confer nothing, so a word appearing
 * elsewhere does not dilute a claim nobody has made — the founding act is whole
 * by definition, and the figure beside it has to agree.
 *
 * A CLAIMED name keeps the saturation reading: one use out of however many
 * threads cite it, which is what tells a citation apart from a founding.
 */
export function hintShareTotal(claimed: boolean, threads: number): number {
  if (!claimed) return 1;
  return Math.max(1, threads);
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
      const [resolved, usage, reservedFlags, quote] = await Promise.all([
        resolveTickers(symbols),
        getTickerUsage(symbols),
        // At most three, and only after the 350ms debounce — see above.
        Promise.all(symbols.map((s) => isReservedTicker(s))),
        // ⚠ WHAT THIS POST WOULD COST TO MINT, shown BEFORE committing. Posting
        // spends the author's own sats, and the price rises with a word's supply
        // — so naming a heavily-used word costs more than naming a fresh one, and
        // an author has every right to know that before they press post rather
        // than after. Display only: the charge is still flat (see getMintQuote).
        getMintQuote(symbols),
      ]);
      const priceOf = new Map(quote.map((q) => [q.symbol, q.priceSats]));
      if (!live) return;
      setStates(
        symbols.map((symbol, i) => ({
          symbol,
          claimed: Boolean(resolved[symbol]),
          reserved: reservedFlags[i],
          threads: usage[symbol] ?? 0,
          priceSats: priceOf.get(symbol),
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
        const total = hintShareTotal(s.claimed, s.threads);
        // Shared with the thread header and the wallet — see lib/share.ts for why
        // this must not be formatted locally.
        const pct = formatShare(1, total);
        return (
          <div key={s.symbol} className="flex items-center gap-2 text-[11px] leading-tight">
            <span className="font-medium text-amber-400">${titleCaseTicker(s.symbol)}</span>
            {/* ⚠ NO FIGURE FOR A RESERVED NAME. A share of a claim that cannot be
                made is not a small number, it is a category error — and "100%"
                beside "you'd be starting it" is the exact sentence this reserved
                name exists to prevent somebody believing. */}
            {!s.reserved && (
              <span
                className={`font-mono tabular-nums ${s.claimed ? "text-zinc-500" : "text-emerald-400"}`}
              >
                {pct}
              </span>
            )}
            {/* ⚠ THE PRICE OF NAMING THIS WORD, BEFORE COMMITTING. Posting spends
                the author's own sats and the mint price rises with a word's
                supply, so naming something heavily used costs more than naming
                something fresh — which an author should learn before they press
                post, not after. Reserved names mint nothing, so they show none.
                Display only: the charge is still flat (see `getMintQuote`). */}
            {!s.reserved && s.priceSats !== undefined && (
              <span className="font-mono tabular-nums text-amber-500/70">
                {s.priceSats.toLocaleString()} sats
              </span>
            )}
            <span className="text-zinc-500">
              {s.reserved ? (
                <span className="text-zinc-400">held — naming it claims nothing</span>
              ) : s.claimed ? (
                <>
                  already claimed — you're citing it
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
