import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { BOTTOM_NAV_HEIGHT_CLASS, BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { getServerAddress } from "@/services/bsv/wallet";
import { listTickers } from "../actions";
import { TickerDirectory } from "../tickers/TickerDirectory";
import { ThreadList } from "./ThreadList";

/**
 * The Threads tab.
 *
 * ⚠ NAMED "THREADS", NOT "CHAT", ON PURPOSE. bChat's fifth tab is private group
 * chat. This board has nothing of the kind, and labelling a public thread list
 * "Chat" beside a wallet would imply a privacy guarantee that does not exist.
 * The route stays `/chat` so the tab bar matches bChat's shape; the words the
 * user reads describe what this actually is.
 *
 * Dynamic rather than static: what it lists depends entirely on who is asking,
 * and that is decided in the browser (see `ThreadList` — the signing key never
 * reaches the server).
 */
/**
 * ⚠ DYNAMIC, AND IT HAS TO BE. Without this Next PRERENDERED THIS PAGE AT BUILD
 * TIME, when the database is empty — so production served a permanently empty
 * directory (`initial: []` was visible in the live payload) while the same code
 * worked locally. `/market` escaped it only by exporting `revalidate`; the
 * leaderboard index carries the same note for the same reason.
 *
 * A directory of everything claimed on the board is exactly the kind of page
 * that must not be frozen at the moment the container was built.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Threads — $OpenBooks",
  description: "Public threads you have started or replied to, newest activity first.",
};

export default async function ChatPage() {
  const tickers = await listTickers();
  return (
    <AppProviders>
      <div className={`min-h-[100dvh] bg-black text-white ${BOTTOM_NAV_HEIGHT_CLASS}`}>
        <SiteNav supportAddress={getServerAddress()} />
        {/* ⚠ `max-w-2xl`, THE SAME COLUMN AS EVERY OTHER PAGE. Without it this
            list ran the full width of the window while `/market`, the feed and
            the leaderboards all sit in a 2xl column — so moving between tabs
            resized the content, which reads as landing on a different site
            rather than a different tab. The width is part of the app's shape,
            not per-page styling. */}
        <div className="mx-auto w-full max-w-2xl">
          <header className="border-b border-zinc-900 px-4 py-3">
            <h1 className="text-sm font-medium text-white">Threads</h1>
            {/* Says the quiet part out loud: nothing here is private. */}
            <p className="mt-0.5 text-[11px] text-zinc-600">
              Every named thread, and the ones you are in. All public — private rooms don't exist
              yet.
            </p>
          </header>

          {/* ⚠ THE NAMED-THREAD DIRECTORY LIVES HERE, NOT UNDER "MARKET" (owner,
              2026-08-16). It was on `/market`, where clicking an entry opened a
              thread — so the Market tab was a thread list wearing a different
              name, and the tab you would actually look for threads in listed only
              your own. A directory of `$Ticker`s IS a directory of conversations;
              it belongs with them. */}
          <ThreadList directory={<TickerDirectory initial={tickers} />} />
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
