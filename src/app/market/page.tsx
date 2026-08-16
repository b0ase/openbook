import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { BOTTOM_NAV_HEIGHT_CLASS, BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { siteOrigin } from "@/lib/site-origin";
import { getServerAddress } from "@/services/bsv/wallet";
import { listTickers } from "../actions";
import { TickerDirectory } from "../tickers/TickerDirectory";

/**
 * The market — every claimed name, ranked by economic weight.
 *
 * ⚠ THE SAME PAGE AS `/tickers`, UNDER THE NAME THE TAB BAR USES. The index
 * already existed and already ranks by weight; what it lacked was a place in the
 * app's navigation. Rather than build a second directory that would drift from
 * the first, this renders the same `TickerDirectory` and `/tickers` redirects
 * here — one implementation, one URL that wins, no divergence.
 *
 * ⚠ STILL SERVER-RENDERED WITH ITS RESULTS IN THE HTML, for the reason the index
 * always was: a directory that only appears after hydration is invisible to the
 * crawlers and agents it exists to reach.
 *
 * What it does NOT list yet: individual posts for sale. TOKENS.md settles that a
 * post is sellable, but no listing or transfer mechanism exists, so a market that
 * showed them would be advertising something nobody can buy.
 */
export const revalidate = 30;

export const metadata: Metadata = {
  title: "Market — $OpenBooks",
  description:
    "Every name claimed on $OpenBooks, ranked by how many posts named it. Attention someone paid for, not a number inferred.",
  openGraph: {
    title: "Market — $OpenBooks",
    description: "Every name claimed on $OpenBooks, ranked by weight.",
    images: [`${siteOrigin()}/og-openbooks.jpg`],
  },
};

export default async function MarketPage() {
  const tickers = await listTickers();
  return (
    <AppProviders>
      <div className={`min-h-[100dvh] bg-black text-white ${BOTTOM_NAV_HEIGHT_CLASS}`}>
        <SiteNav supportAddress={getServerAddress()} />
        <TickerDirectory initial={tickers} />
        <BottomNav />
      </div>
    </AppProviders>
  );
}
