"use client";

import { AgentChat } from "@/app/AgentChat";
import { AppProviders } from "@/components/AppProviders";
import { BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";

/**
 * Client shell for the Agent tab.
 *
 * A client component because `AgentChat` is one and the tab opens it on mount.
 * `SiteNav` renders the wallet chip, which needs the identity context, so the
 * whole page sits inside `AppProviders` — one stack per tree, see the note there.
 *
 * The support address is omitted rather than fetched: it is a server value, and
 * this surface is about talking to the agent, not about the treasury.
 */
export function AgentPanel() {
  return (
    <AppProviders>
      <div className="flex h-[100dvh] flex-col bg-black text-white">
        <SiteNav />
        {/* The ONLY scrolling region — see the market page for why. */}
        {/* ⚠ NO INNER SCROLLER HERE. The agent owns this region and scrolls its
            OWN message list; a scroller wrapping a scroller gives the page two
            bars and traps the conversation inside a box. */}
        <div className="min-h-0 flex-1">
          {/* ⚠ NO PAGE HEADING ABOVE THE AGENT. A title and a blurb over a chat
              turn it back into a widget embedded in a document — the thing the
              card already was. The agent's own header names it, and the tab bar
              says which tab you are on, so anything else here is a caption on a
              caption. bChat's composer is full-bleed for the same reason. */}
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
            <AgentChat openOnMount fullPage />
          </div>
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
