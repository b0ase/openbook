import { AppProviders } from "./AppProviders";
import { BottomNav } from "./BottomNav";
import { LegalDoc } from "./LegalDoc";
import { SiteNav } from "./SiteNav";

/** Shared shell for the /terms and /privacy pages: the site nav, a clear DRAFT
 *  banner (the legal/*.md are not yet lawyer-final), and the rendered doc.
 *
 *  The bespoke "← Back to OpenBooks" link is gone: `SiteNav`'s wordmark is the
 *  way home on every other page, and two different controls for one action is
 *  how a site ends up feeling like several sites. */
export function LegalPageShell({ markdown }: { markdown: string }) {
  return (
    // `SiteNav` renders the wallet chip, which is an identity consumer — see the
    // note in `AppProviders` for why the providers live at the page and not
    // inside the chip.
    <AppProviders>
      {/* The tab bar belongs on EVERY page a reader can reach — landing on Terms
          from a modal footer previously stranded them with no way back into the
          app. The scroller moves onto the middle row so the bar cannot scroll. */}
      <div className="flex h-[100dvh] flex-col bg-black text-zinc-200">
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <SiteNav />
          <div className="mx-auto max-w-2xl px-5 py-8">
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-xs leading-relaxed text-amber-200/90">
              <strong className="font-semibold">Draft — not final.</strong> This is a working draft
              and will be finalized before public launch. It is not legal advice.
            </div>
            <article className="mt-6 pb-16">
              <LegalDoc markdown={markdown} />
            </article>
          </div>
        </main>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
