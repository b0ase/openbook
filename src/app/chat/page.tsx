import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { BOTTOM_NAV_HEIGHT_CLASS, BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { getServerAddress } from "@/services/bsv/wallet";
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
export const metadata: Metadata = {
  title: "Threads — $OpenBooks",
  description: "Public threads you have started or replied to, newest activity first.",
};

export default function ChatPage() {
  return (
    <AppProviders>
      <div className={`min-h-[100dvh] bg-black text-white ${BOTTOM_NAV_HEIGHT_CLASS}`}>
        <SiteNav supportAddress={getServerAddress()} />
        <header className="border-b border-zinc-900 px-4 py-3">
          <h1 className="text-sm font-medium text-white">Threads</h1>
          {/* Says the quiet part out loud: nothing here is private. */}
          <p className="mt-0.5 text-[11px] text-zinc-600">
            Conversations you are part of. All public — private rooms don't exist yet.
          </p>
        </header>
        <ThreadList />
        <BottomNav />
      </div>
    </AppProviders>
  );
}
