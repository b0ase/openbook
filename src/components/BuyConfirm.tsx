"use client";

import { useEffect, useState } from "react";
import { getMintCharge, getMintQuote } from "@/app/actions";
import { useBsvPrice } from "@/hooks/useBsvPrice";
import { type BuyCommand, buyCommandText } from "@/lib/buy-command";
import { mintPriceSats } from "@/lib/mint-price";
import { titleCaseTicker } from "@/lib/ticker";

/**
 * What `/buy 1000 $Memeplex` will cost, before it costs it.
 *
 * ⚠ THIS IS NOT A POLITENESS. A buy walks up the curve, so the price is
 * QUADRATIC in the number of units — a thousand units of a word cost roughly
 * five hundred times one unit, and no amount of familiarity with the syntax
 * makes that number guessable from the command. A command that spends an
 * unbounded amount of somebody's money with no figure in front of them is a
 * trap, however clearly the feature is documented.
 *
 * The figure shown is the one the server will charge — `getMintCharge` is the
 * same function `payForPost` funds from, not a second local calculation that
 * could drift from it. The two derived numbers beside it (the average paid, and
 * what the next buyer will pay) come from the shared pure curve.
 */
export function BuyConfirm({
  buy,
  onCancel,
  onConfirm,
}: {
  buy: BuyCommand;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [totalSats, setTotalSats] = useState<number | null>(null);
  const [supply, setSupply] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const bsvPrice = useBsvPrice();
  const text = buyCommandText(buy);

  useEffect(() => {
    let live = true;
    Promise.all([getMintCharge(text), getMintQuote([buy.symbol])])
      .then(([charge, quote]) => {
        if (!live) return;
        setTotalSats(charge);
        setSupply(quote[0]?.supply ?? 0);
      })
      // ⚠ NO PRICE, NO PURCHASE. Falling back to an estimate would put a number
      // in front of somebody that the server has not agreed to.
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [text, buy.symbol]);

  const usd = totalSats !== null && bsvPrice > 0 ? (totalSats / 1e8) * bsvPrice : null;
  const average = totalSats !== null ? Math.round(totalSats / buy.units) : null;
  const nextPrice = supply !== null ? mintPriceSats(supply + buy.units) : null;

  return (
    <>
      {/* A real BUTTON for the backdrop, the same shape `SignInModal` uses — a
          div with an onClick is unreachable by keyboard and Biome rejects it. */}
      <button
        type="button"
        aria-label="Cancel purchase"
        onClick={onCancel}
        className="fixed inset-0 z-[70] w-full cursor-default bg-black/75 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center px-6">
        <div
          className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl border border-amber-400/20 bg-[#0f0f0f] shadow-[0_8px_32px_rgba(0,0,0,0.6)]"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm purchase"
        >
          <div className="h-[3px] bg-amber-400" />
          <div className="px-5 py-4">
            <h2 className="text-[15px] font-semibold tracking-tight">
              Buy {buy.units.toLocaleString()} {buy.units === 1 ? "unit" : "units"} of{" "}
              <span className="text-amber-400">${titleCaseTicker(buy.symbol)}</span>
            </h2>

            {failed ? (
              <p className="mt-3 text-[13px] leading-relaxed text-red-400">
                Couldn't price that right now — nothing was spent. Reload and try again.
              </p>
            ) : totalSats === null ? (
              <p className="mt-3 text-[13px] text-zinc-500">Pricing…</p>
            ) : (
              <>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="font-mono text-2xl tabular-nums text-white">
                    {totalSats.toLocaleString()}
                  </span>
                  <span className="text-[13px] text-zinc-500">sats</span>
                  {usd !== null && (
                    <span className="ml-auto font-mono text-[13px] tabular-nums text-zinc-500">
                      ≈ ${usd < 0.01 ? usd.toFixed(5) : usd.toFixed(2)}
                    </span>
                  )}
                </div>

                {/* ⚠ THE AVERAGE AND THE NEW CEILING, TOGETHER. They are the whole
                  reason to buy in bulk rather than one at a time, and they are
                  also what makes the size of the purchase matter to everybody
                  else — so a buyer should see both before committing, not work
                  them out afterwards. */}
                <dl className="mt-3 space-y-1.5 text-[12px]">
                  {average !== null && (
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">Average per unit</dt>
                      <dd className="font-mono tabular-nums text-zinc-300">
                        {average.toLocaleString()} sats
                      </dd>
                    </div>
                  )}
                  {nextPrice !== null && (
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">Next unit costs after this</dt>
                      <dd className="font-mono tabular-nums text-amber-400">
                        {nextPrice.toLocaleString()} sats
                      </dd>
                    </div>
                  )}
                </dl>

                <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                  Each unit is priced separately up the curve, so this raises what the next buyer
                  pays. Units are yours, listed in your wallet. Reselling isn't built yet.
                </p>
              </>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 rounded-lg border border-zinc-800 py-2 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={totalSats === null || failed}
                onClick={() => onConfirm(text)}
                className="flex-1 rounded-lg bg-amber-500 py-2 text-[13px] font-medium text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                Buy
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
