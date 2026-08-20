import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { mintPriceSats } from "@/lib/mint-price";
import { OG_IMAGE_PATH, siteOrigin } from "@/lib/site-origin";
import { leaderboardHref, titleCaseTicker } from "@/lib/ticker";
import { getServerAddress } from "@/services/bsv/wallet";
import { listTickerBoards } from "../actions";

/**
 * The Market tab — what exists, how much of it, and how many people hold it.
 *
 * ⚠ IT USED TO BE THE `$Ticker` DIRECTORY, AND THAT WAS THE WRONG TAB (owner,
 * 2026-08-16). Clicking an entry opened a THREAD, so "Market" was a thread list
 * under another name, while the Threads tab listed only your own. The directory
 * moved to `/chat`, where a list of conversations belongs.
 *
 * ⚠ THINGS ARE NOW ACTUALLY FOR SALE HERE. Holders can list units and buyers can
 * fill those listings (`market.ts`), so each row carries TWO prices: the cheapest
 * second-hand unit on offer, and what minting a fresh one costs.
 *
 * The mint price is NOT a ceiling on what a holder may ask (owner, 2026-08-17) —
 * it is the price of the last resort, the thing a buyer falls back to. An ask
 * above it is a limit order waiting for the curve to rise past it. The buyer
 * simply takes whichever is cheaper today, which is why both are shown.
 *
 * ⚠ NO PER-TICKER ADDRESSES YET. The owner asked for each token's public address
 * alongside its value. Tokens do not have addresses: HD derivation is designed in
 * TOKENS.md and not built, so any address shown here would be invented. When
 * derivation lands this is the page that gains a column, and the wallet balance
 * at that address becomes the first honest measure of what a word is worth.
 */
/**
 * ⚠ DYNAMIC, NOT ISR. With `revalidate` this page is PRERENDERED AT BUILD TIME,
 * when the database is empty — so every deploy served an empty market until the
 * first revalidation. `/chat` hit exactly that and served `initial: []` in
 * production while working locally. One indexed GROUP BY per request is the same
 * cost `/leaderboard` already accepted for the same reason.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Market — $OpenBooks",
  description: "Every token on $OpenBooks, how many units exist, and how many people hold one.",
  openGraph: {
    title: "Market — $OpenBooks",
    description: "Every token on $OpenBooks and who holds it.",
    images: [`${siteOrigin()}${OG_IMAGE_PATH}`],
  },
};

export default async function MarketPage() {
  const boards = await listTickerBoards();

  return (
    <AppProviders>
      <div className="flex h-[100dvh] flex-col bg-black text-white">
        <SiteNav supportAddress={getServerAddress()} />
        {/* The ONLY scrolling region. Everything outside it — the header above and
            the tab bar below — is fixed by structure rather than by
            `position: fixed`, so neither can be scrolled away or mispositioned. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            <h1 className="text-lg font-semibold tracking-tight">
              <span className="text-amber-400">Market</span>
            </h1>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              The price of the next unit, how many exist, and how many people hold one. A unit is
              minted for each post that names it, and the price rises with supply — so an early unit
              is worth what it now costs to mint a fresh one.{" "}
              {/* Both prices are real: the curve is what an author is billed
                  (`mint-charge.ts`) and the ask is a live offer somebody has
                  signed for. */}
              <span className="text-zinc-600">
                Green is the cheapest unit somebody is selling; amber is what minting a new one
                costs.
              </span>
            </p>

            <ol className="mt-5 divide-y divide-zinc-800/60">
              {boards.map((b) => (
                <li key={b.symbol}>
                  <a
                    href={leaderboardHref(b.path)}
                    className="flex items-baseline justify-between gap-3 py-3 transition-colors hover:text-amber-300"
                  >
                    {/* ⚠ THE LEAF ONLY, NO ANCESTRY. A nested token rendered as
                        `$Memeplex/$Words` beside plain `$Ticker` rows made two
                        different KINDS of thing appear in one list — and a market
                        lists assets, where `$Words` is the asset and its parent is
                        provenance. The path still shows on the board itself and in
                        the leaderboards, where the hierarchy IS the subject; here
                        it only made the list read inconsistently. `leaderboardHref`
                        still takes the full path, so the link is unchanged. */}
                    <span className="min-w-0 truncate font-medium text-amber-400">
                      ${titleCaseTicker(b.symbol)}
                    </span>
                    <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {/* ⚠ EVERY TOKEN HAS A DIFFERENT PRICE, and that is the
                          point. The mint price rises with supply, so this is the
                          cost of the NEXT unit of this particular word — which is
                          also the ceiling on what its seats resell for, since
                          nobody rationally pays more second-hand than it costs to
                          mint a fresh one. A market page without prices on it is
                          just a list of names. */}
                      {/* ⚠ TWO PRICES WHEN THERE ARE TWO. The mint price is
                          what a NEW unit costs and it is a ceiling; the ask is
                          what an existing one costs and it is normally lower.
                          Showing only the mint price on a page called Market
                          would hide the market. */}
                      {b.ask !== null && b.ask < mintPriceSats(b.total) ? (
                        <>
                          <span className="text-emerald-400">{b.ask.toLocaleString()} sats</span>
                          <span className="text-zinc-700"> · mint </span>
                          <span className="text-amber-500/60">
                            {mintPriceSats(b.total).toLocaleString()}
                          </span>
                        </>
                      ) : (
                        <span className="text-amber-500/80">
                          {mintPriceSats(b.total).toLocaleString()} sats
                        </span>
                      )}
                      <span className="text-zinc-700"> · </span>
                      {b.total} {b.total === 1 ? "unit" : "units"}
                      <span className="text-zinc-700"> · </span>
                      {/* The number the owner actually asked for: how many PEOPLE
                        hold one, not just how many units were minted. A word held
                        by forty people is a different asset from one word held
                        forty times by its author. */}
                      {b.holders} {b.holders === 1 ? "holder" : "holders"}
                    </span>
                  </a>
                </li>
              ))}
            </ol>

            {boards.length === 0 && (
              <p className="mt-8 text-center text-sm text-zinc-600">
                No tokens yet. Name something with a $Ticker and it appears here.
              </p>
            )}
          </div>
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
