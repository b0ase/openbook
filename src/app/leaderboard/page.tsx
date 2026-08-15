import type { Metadata } from "next";
import { SiteNav } from "@/components/SiteNav";
import { leaderboardHref, titleCaseTicker } from "@/lib/ticker";
import { listTickerBoards } from "../actions";

/**
 * `/leaderboard` — every token that has a board.
 *
 * ⚠ THIS PAGE HAS TO EXIST, because a catch-all matches one segment or more and
 * never zero: `/leaderboard/[...ticker]` answers `/leaderboard/$memeplex` and
 * nothing at all at `/leaderboard`. That bare path is the obvious one to link
 * and the one people type, and it was 404ing.
 *
 * ⚠ IT IS NOT A REDIRECT TO THE ROOT TOKEN'S BOARD. Sending "the leaderboard"
 * to one name's holder list is a category error — `$OpenBooks` is one token
 * among the ones listed here, not a stand-in for all of them.
 *
 * Distinct from `/tickers`, which indexes NAMES: what has been claimed and by
 * which post. This indexes OWNERSHIP — how many units exist and how many people
 * hold them — which is the question a payout roster answers.
 *
 * Server-rendered for the same reason the individual boards are: these are the
 * numbers a split pays against, so they have to be readable without running our
 * JavaScript.
 */
/**
 * ⚠ DYNAMIC, unlike the individual boards which are dynamic for free by having
 * params. This page has none, so Next prerenders it AT BUILD TIME — and the
 * build runs in a container with no volume mounted, against an empty database.
 * Every deploy would publish a leaderboard reading "0 units" from the header of
 * every page until something revalidated it. One indexed GROUP BY per request is
 * the cheaper mistake.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboards — $OpenBooks",
  description: "Every token on $OpenBooks and who holds it. One unit for every post that named it.",
};

export default async function LeaderboardIndex() {
  const boards = await listTickerBoards();

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <SiteNav />
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <h1 className="text-lg font-semibold tracking-tight">
          <span className="text-amber-400">Leaderboards</span>
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
          Every token and who holds it. One unit for every post that named it.
        </p>

        <ol className="mt-5 divide-y divide-zinc-800/60">
          {boards.map((b) => (
            <li key={b.symbol}>
              <a
                href={leaderboardHref(b.path)}
                className="flex items-baseline justify-between gap-3 py-3 hover:text-amber-300 transition-colors"
              >
                <span className="min-w-0 truncate">
                  {/* Ancestry dimmed: it is context, the leaf is the subject —
                      the same treatment the thread header and the board itself
                      give a path, so one name looks like itself everywhere. */}
                  {b.path.slice(0, -1).map((seg) => (
                    <span key={seg} className="text-zinc-600">
                      ${titleCaseTicker(seg)}
                      <span className="text-zinc-700">/</span>
                    </span>
                  ))}
                  <span className="font-medium text-amber-400">${titleCaseTicker(b.symbol)}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                  {b.total} {b.total === 1 ? "unit" : "units"}
                  <span className="text-zinc-700"> · </span>
                  {/* Said plainly rather than shown as a percentage: a share of
                      what is only meaningful on the board itself, where the
                      unowned remainder is also on the page. */}
                  {b.holders} {b.holders === 1 ? "holder" : "holders"}
                </span>
              </a>
            </li>
          ))}
        </ol>

        <p className="mt-8 flex justify-center gap-4 text-[12px] text-zinc-600">
          <a href="/tickers" className="hover:text-amber-400 transition-colors">
            All names
          </a>
          <a href="/" className="hover:text-amber-400 transition-colors">
            The board
          </a>
        </p>
      </div>
    </div>
  );
}
