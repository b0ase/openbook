import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppProviders } from "@/components/AppProviders";
import { SiteNav } from "@/components/SiteNav";
import { formatShare } from "@/lib/share";
import { siteOrigin } from "@/lib/site-origin";
import { parseTickerPath, tickerHref, titleCaseTicker } from "@/lib/ticker";
import { getServerAddress } from "@/services/bsv/wallet";
import { getTickerLeaderboard } from "../../actions";

/**
 * Who holds a token — the payout roster, published.
 *
 * ⚠ THE ROUTE IS `/leaderboard/$a/$b`, NOT `/$a/$b/leaderboard`, AND THAT IS
 * FORCED. `[...ticker]` is a catch-all, and Next refuses any segment after one:
 * `/[...ticker]/leaderboard` is a BUILD failure ("Catch-all must be the last
 * part of the URL"), the same rule that pushed the social card out to
 * `/api/og`. Putting the literal segment FIRST is what makes this legal.
 *
 * ⚠ SERVER-RENDERED, deliberately. This is the roster a payment will actually
 * pay (DECISIONS.md — the split pays the top 100 holders), so it has to be
 * readable without running our JavaScript: by a crawler, by an agent, by
 * somebody checking whether the numbers we publish match the money we send.
 *
 * A ticker resolves by its LAST path segment — symbols are unique (PRIMARY KEY),
 * so the ancestry in the URL is for humans, and the tail is the identifier.
 */
export const revalidate = 30;

type Params = { params: Promise<{ ticker: string[] }> };

function symbolFrom(segments: string[]): string {
  const parsed = parseTickerPath(`/${segments.join("/")}`);
  return parsed.at(-1) ?? "";
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { ticker } = await params;
  const symbol = symbolFrom(ticker);
  const name = symbol ? `$${titleCaseTicker(symbol)}` : "Token";
  return {
    title: `${name} holders — $OpenBooks`,
    description: `Who holds ${name}, largest first. Every unit is a post that named it.`,
    openGraph: {
      title: `${name} holders`,
      description: `Who holds ${name} on $OpenBooks.`,
      images: [`${siteOrigin()}/og-openbooks.jpg`],
    },
  };
}

export default async function LeaderboardPage({ params }: Params) {
  const { ticker } = await params;
  const symbol = symbolFrom(ticker);
  const board = symbol ? await getTickerLeaderboard(symbol) : null;
  // A name nobody has ever written is not an empty leaderboard, it is not a
  // token — 404 rather than render a page implying it exists.
  if (!board) notFound();

  const unowned = board.total - board.attributed;
  const threadHref = tickerHref(board.path);

  return (
    <AppProviders>
      <div className="min-h-[100dvh] bg-black text-white">
        <SiteNav supportAddress={getServerAddress()} />
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <h1 className="text-lg font-semibold tracking-tight">
            {board.path.slice(0, -1).map((seg) => (
              <span key={seg} className="text-zinc-600">
                ${titleCaseTicker(seg)}
                <span className="text-zinc-700">/</span>
              </span>
            ))}
            <span className="text-amber-400">${titleCaseTicker(board.symbol)}</span>
            <span className="text-zinc-500"> holders</span>
          </h1>

          <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
            {board.total} {board.total === 1 ? "unit" : "units"} issued &mdash; one for every post
            that named it. Largest holder first.
          </p>

          {board.holders.length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-600">
              No unit of this name has an owner yet.
            </p>
          ) : (
            <ol className="mt-5 divide-y divide-zinc-800/60">
              {board.holders.map((h, i) => (
                <li key={h.pubkey} className="flex items-baseline justify-between gap-3 py-3">
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span className="w-6 shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">
                      {i + 1}
                    </span>
                    {/* A claimed name identifies its holder; without one the
                      pubkey is the only honest identifier there is, truncated
                      because it is unreadable by nature. */}
                    {h.nym ? (
                      <span className="truncate font-medium text-amber-400">
                        ${titleCaseTicker(h.nym)}
                      </span>
                    ) : (
                      <span className="truncate font-mono text-[12px] text-zinc-500">
                        {h.pubkey.slice(0, 10)}&hellip;{h.pubkey.slice(-4)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-sm tabular-nums text-white">
                      {h.units}
                    </span>
                    <span className="block font-mono text-[10px] tabular-nums text-zinc-600">
                      {formatShare(h.units, board.total)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}

          {/* ⚠ Stated, not hidden. Genesis posts carry no pubkey, so their units
            have no owner — and without this line the listed shares would fail
            to add up to 100% with no explanation on the page. */}
          {unowned > 0 && (
            <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
              {unowned} {unowned === 1 ? "unit has" : "units have"} no owner &mdash;{" "}
              {formatShare(unowned, board.total)} of the supply. These came from posts written
              before signing, so there is nobody to credit them to.
            </p>
          )}

          <p className="mt-8 flex justify-center gap-4 text-[12px] text-zinc-600">
            <a href={threadHref} className="hover:text-amber-400 transition-colors">
              Open the thread
            </a>
            <a href="/tickers" className="hover:text-amber-400 transition-colors">
              All names
            </a>
          </p>
        </div>
      </div>
    </AppProviders>
  );
}
