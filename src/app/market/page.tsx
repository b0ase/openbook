import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { siteOrigin } from "@/lib/site-origin";
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
 * ⚠ NOTHING IS FOR SALE HERE, AND THE PAGE SAYS SO. TOKENS.md settles that a post
 * is sellable and that names can change hands, but no listing, offer or trade
 * mechanism is built. So this shows OWNERSHIP rather than pretending to a market:
 * every token, how many units exist, and how many distinct people hold one. That
 * is the honest interim and it is what a real market grows out of — you cannot
 * sell what nobody can see you hold.
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
    images: [`${siteOrigin()}/og-openbooks.jpg`],
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
              Every token, how many units exist, and how many people hold one. A unit is minted for
              each post that names it.{" "}
              {/* Said plainly rather than left to be discovered by tapping. */}
              <span className="text-zinc-600">Nothing is for sale yet.</span>
            </p>

            <ol className="mt-5 divide-y divide-zinc-800/60">
              {boards.map((b) => (
                <li key={b.symbol}>
                  <a
                    href={leaderboardHref(b.path)}
                    className="flex items-baseline justify-between gap-3 py-3 transition-colors hover:text-amber-300"
                  >
                    <span className="min-w-0 truncate">
                      {/* Ancestry dimmed, leaf emphasised — the same treatment the
                        thread header and the leaderboards give a path, so one
                        name looks like itself everywhere it appears. */}
                      {b.path.slice(0, -1).map((seg) => (
                        <span key={seg} className="text-zinc-600">
                          ${titleCaseTicker(seg)}
                          <span className="text-zinc-700">/</span>
                        </span>
                      ))}
                      <span className="font-medium text-amber-400">
                        ${titleCaseTicker(b.symbol)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500">
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
