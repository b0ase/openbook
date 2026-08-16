"use client";

import { IdentityChip } from "@/app/IdentityBar";
import { AppProviders } from "@/components/AppProviders";
import { BOTTOM_NAV_HEIGHT_CLASS, BottomNav } from "@/components/BottomNav";
import { SiteNavLinks } from "@/components/SiteNav";

/**
 * Client shell for the Wallet tab.
 *
 * ⚠ NO `SiteNav` HERE, DELIBERATELY. That header renders the wallet chip in the
 * corner, and this page opens the wallet itself — the same control twice on one
 * screen, one of them already expanded. The wordmark and links are kept so the
 * page is still navigable; the chip is the page.
 */
export function WalletPanel() {
  return (
    <AppProviders>
      <div className={`min-h-[100dvh] bg-black text-white ${BOTTOM_NAV_HEIGHT_CLASS}`}>
        <header className="border-b border-zinc-800 bg-black">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
            <a href="/" className="group">
              <span className="text-lg font-semibold leading-none tracking-tight">
                <span className="text-amber-400">$Open</span>
                <span className="text-white transition-colors group-hover:text-zinc-300">Book</span>
              </span>
            </a>
            <SiteNavLinks />
          </div>
        </header>
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-amber-400">Your</span> wallet
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
            What you hold, what you have earned, and the recovery file that keeps it yours.
          </p>
          <div className="mt-6 flex justify-center">
            <IdentityChip openOnMount />
          </div>
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
