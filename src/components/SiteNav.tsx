import { SiteIdentity } from "./SiteIdentity";
import { SupportAddress } from "./SupportAddress";

/**
 * Site navigation, shared by the feed's header and by every other page.
 *
 * ⚠ THE LINKS LIVE IN ONE PLACE ON PURPOSE. They were added to the feed header
 * only, so following one to `/tickers` or `/leaderboard` dropped you onto a page
 * with no way back and no sign of where you were — the front page could reach
 * the index, and the index could reach nothing. A nav that exists on one screen
 * is not navigation.
 *
 * Two exports rather than one component used twice: the feed header already
 * renders the wordmark (and an absolutely-centred Genesis control that anything
 * wider would slide under), so it takes `SiteNavLinks` alone. Standalone pages
 * take `SiteNav`, which adds the wordmark as the way home.
 *
 * Plain `<a>`, not `next/link`: the feed is the root route and leaving it is a
 * real navigation either way, and these are the only links out of a page whose
 * scroll state the feed deliberately owns.
 */

/** The links themselves — "Tickers · Leaderboard". */
export function SiteNavLinks({ className = "" }: { className?: string }) {
  return (
    <nav
      className={`flex items-center gap-2.5 text-[11px] leading-none text-zinc-500 ${className}`}
    >
      {/* ⚠ THE LABEL IS THE ROUTE. These read "Names" and "Holders", which named
          neither the page you land on nor the URL you can see in the address
          bar — so following one and trying to describe where you were took a
          translation step. A nav label that has to be decoded is not a label. */}
      <a href="/tickers" className="hover:text-amber-400 transition-colors">
        Tickers
      </a>
      <span aria-hidden="true" className="text-zinc-700">
        ·
      </span>
      {/* The INDEX, not one token's board — `$OpenBooks` is one token among
          those listed, not a stand-in for all of them. */}
      <a href="/leaderboard" className="hover:text-amber-400 transition-colors">
        Leaderboard
      </a>
    </nav>
  );
}

/**
 * The full bar for a standalone page: wordmark home, then the links.
 *
 * The wordmark is the breadcrumb. Without it these pages are reachable and not
 * leaveable, which is the half of the problem a link row alone does not solve.
 */
export function SiteNav({ supportAddress = null }: { supportAddress?: string | null }) {
  return (
    // `shrink-0`: the tab pages are flex columns, and without it a long page
    // squeezes the header instead of scrolling the region between it and the bar.
    <header className="shrink-0 border-b border-zinc-800 bg-black">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
        <a href="/" className="group">
          <span className="text-lg font-semibold tracking-tight leading-none">
            <span className="text-amber-400">$Open</span>
            <span className="text-white group-hover:text-zinc-300 transition-colors">Book</span>
          </span>
        </a>
        <div className="flex items-center gap-3">
          <SiteNavLinks />
          <SiteIdentity />
        </div>
      </div>
      {/* ⚠ THE SAME BAR THE FEED SHOWS, ON EVERY PAGE. The treasury line only
          existed on the front page, so every other page quietly dropped the one
          piece of chrome that says who pays for the thing you are reading. If it
          is worth showing at all it is worth showing where people land — and
          people land on a ticker page from a link far more often than on the
          root. */}
      {supportAddress && (
        <div className="border-t border-zinc-900">
          <SupportAddress address={supportAddress} />
        </div>
      )}
    </header>
  );
}
