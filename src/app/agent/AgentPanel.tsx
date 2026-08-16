"use client";

import { AgentChat } from "@/app/AgentChat";
import { AppProviders } from "@/components/AppProviders";
import { BOTTOM_NAV_HEIGHT_CLASS, BottomNav } from "@/components/BottomNav";
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
      <div className={`min-h-[100dvh] bg-black text-white ${BOTTOM_NAV_HEIGHT_CLASS}`}>
        <SiteNav />
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-amber-400">Ask</span> the agent
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
            It reads this project's own notes — how posting works, what a $Ticker is, what the token
            model does and does not do yet.
          </p>
          <div className="mt-6 flex justify-center">
            <AgentChat openOnMount />
          </div>
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
