import type { Metadata } from "next";
import { siteOrigin } from "@/lib/site-origin";
import { listTickers } from "../actions";
import { TickerDirectory } from "./TickerDirectory";

/**
 * The index: every claimed name, ranked by economic weight.
 *
 * ⚠ A STATIC ROUTE, WHICH IS WHY IT WORKS. `[...ticker]` is a catch-all that
 * would otherwise swallow `/tickers`; a literal segment takes precedence over a
 * catch-all in the App Router, so this resolves here rather than being read as a
 * (malformed) ticker path.
 *
 * ⚠ SERVER-RENDERED WITH ITS RESULTS ALREADY IN THE HTML. The whole argument for
 * this page (DIRECTION.md — a ranking signal that costs money) depends on the
 * outside world being able to READ the index. A directory that only appears after
 * hydration is invisible to exactly the crawlers and agents it exists to reach.
 *
 * ⚠ STILL BEHIND `ALLOW_INDEXING`. The root layout emits `noindex` until that env
 * var is set, so this page is crawlable in structure but not yet in policy. That
 * is correct for a quiet launch and must be flipped at go-public — an index
 * nobody may index is a contradiction, and it is recorded as one in DIRECTION.md.
 */
export const revalidate = 30;

export const metadata: Metadata = {
  title: "Index — $OpenBooks",
  description:
    "Every name claimed on $OpenBooks, ranked by how many posts named it. Attention someone paid for, not a number inferred.",
  openGraph: {
    title: "Index — $OpenBooks",
    description: "Every name claimed on $OpenBooks, ranked by weight.",
    images: [`${siteOrigin()}/og-openbooks.jpg`],
  },
};

export default async function TickersPage() {
  const tickers = await listTickers();
  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <TickerDirectory initial={tickers} />
    </div>
  );
}
