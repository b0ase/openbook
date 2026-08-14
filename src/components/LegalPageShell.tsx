import Link from "next/link";
import { LegalDoc } from "./LegalDoc";

/** Shared shell for the /terms and /privacy pages: back link, a clear DRAFT
 *  banner (the legal/*.md are not yet lawyer-final), and the rendered doc. */
export function LegalPageShell({ markdown }: { markdown: string }) {
  return (
    <main className="h-[100dvh] overflow-y-auto bg-black text-zinc-200">
      <div className="mx-auto max-w-2xl px-5 py-8">
        <Link href="/" className="text-xs text-amber-400 transition-colors hover:text-amber-300">
          ← Back to OpenBooks
        </Link>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-xs leading-relaxed text-amber-200/90">
          <strong className="font-semibold">Draft — not final.</strong> This is a working draft and
          will be finalized before public launch. It is not legal advice.
        </div>
        <article className="mt-6 pb-16">
          <LegalDoc markdown={markdown} />
        </article>
      </div>
    </main>
  );
}
