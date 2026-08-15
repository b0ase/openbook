"use client";

import { IdentityChip } from "./IdentityBar";

interface HeaderProps {
  isAtTop: boolean;
  genesisHydrated: boolean;
  genesisVisited: boolean;
  onScrollToGenesis: () => void;
  /** Open a token's thread from the wallet panel. */
  onOpenThread?: (rootId: number) => void;
}

export function Header({
  isAtTop,
  genesisHydrated,
  genesisVisited,
  onScrollToGenesis,
  onOpenThread,
}: HeaderProps) {
  return (
    <header className="shrink-0 border-b border-zinc-800 bg-black">
      {/* pt = safe-area-inset-top + 12px so the "OpenBooks" logo and anon chip
          aren't covered by the PWA status bar (where statusBarStyle is
          black-translucent — content extends behind the status bar). In
          Safari the env value resolves to 0 so the original 12px is
          preserved. */}
      <div className="relative mx-auto flex max-w-2xl items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
        <div>
          {/* The wordmark IS the ticker (TOKENS.md: the root token is $OpenBooks).
              The `$` carries the amber with "Open" so the lockup stays the same
              two-tone it has always been, rather than adding a third colour. */}
          {/* No subtitle. "Agentic Fairness" described the payout engine, which
              is not the point being made here — the fork is about what a user
              can DO (start a thread, mark it, mint it), not about how the split
              is computed. Left empty rather than guessed at: the replacement
              line depends on token decisions that are still open (TOKENS.md
              "Open questions"). The Genesis jump this text used to carry lives
              on the header chevron, which shows whenever you are not at the top. */}
          <h1 className="text-lg font-semibold tracking-tight leading-none">
            <span className="text-amber-400">$Open</span>Books
          </h1>
          {/* ⚠ UNDER the wordmark, not beside it. The Genesis control in the
              middle is absolutely positioned, so anything widening this group
              slides under it on a narrow screen — a second line stays clear of
              it at every width and costs ~14px of header.

              Wording matches what these pages already call themselves ("All
              names" on the leaderboard footer), so the same place is not called
              two things depending on where you came from. */}
          <nav className="mt-1 flex items-center gap-2.5 text-[11px] leading-none text-zinc-500">
            <a href="/tickers" className="hover:text-amber-400 transition-colors">
              Names
            </a>
            <span aria-hidden="true" className="text-zinc-700">
              ·
            </span>
            {/* The INDEX, not one token's board — `$OpenBooks` is one token
                among those listed, not a stand-in for all of them. */}
            <a href="/leaderboard" className="hover:text-amber-400 transition-colors">
              Holders
            </a>
          </nav>
        </div>

        <div className="absolute left-1/2 -translate-x-1/2">
          {genesisHydrated &&
            !isAtTop &&
            (genesisVisited ? (
              <button
                type="button"
                onClick={onScrollToGenesis}
                className="relative -m-3 p-3 hover:text-amber-400 transition-colors"
                title="Back to Genesis"
              >
                <svg
                  width="16"
                  height="8"
                  viewBox="0 0 16 8"
                  fill="none"
                  aria-hidden="true"
                  className="text-zinc-700 hover:text-amber-400/60"
                >
                  <path
                    d="M1 7l7-5 7 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={onScrollToGenesis}
                className="flex items-center gap-1 sm:gap-1.5 rounded-full bg-zinc-800 border border-zinc-700 px-2 py-2 sm:px-3 sm:py-1.5 text-[11px] sm:text-xs text-zinc-400 shadow-lg hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className="text-amber-400"
                >
                  <path
                    d="M8 13V3m0 0l-4 4m4-4l4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="hidden sm:inline">Genesis</span>
                <span className="sm:hidden">Origin</span>
              </button>
            ))}
        </div>

        <IdentityChip onOpenThread={onOpenThread} />
      </div>
    </header>
  );
}
