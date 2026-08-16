"use client";

import { usePathname } from "next/navigation";

/**
 * The app's bottom tab bar, ported from bChat (`bit-sign/src/components/BottomNav.tsx`).
 *
 * ⚠ THE PORTFOLIO SHOULD READ AS ONE SYSTEM, which is the whole reason this
 * exists — bChat, bMovies and this board share a five-slot bar with a raised
 * centre so moving between them feels like moving inside one product rather than
 * between three. The SHAPE is shared; what lives in each tab is this board's own.
 *
 * ⚠ THE ORDER DIFFERS FROM bCHAT DELIBERATELY (owner, 2026-08-16). bChat runs
 * Home · Wallet · [agent] · Market · Chat with the AGENT raised in the centre,
 * because in a chat app the agent is the thing that is different in kind. Here
 * Home is dropped, the agent moves to the far left, and the FEED takes the
 * centre — on a board the feed is the primary action, and a raised button that
 * is not the main thing you came to do is decoration.
 *
 * The centre slot is raised and larger for the same reason it is in bChat: it is
 * the one tab reachable without aiming, on a phone, with a thumb.
 */

type Tab = "agent" | "wallet" | "feed" | "market" | "chat";

/** 24×24 stroke icons — matched to bChat's set so the bars read as one family. */
const ICONS: Record<Tab, React.ReactNode> = {
  agent: (
    <>
      <path d="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4z" />
      <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1" />
    </>
  ),
  // The centre tab draws the wordmark instead of a stroke glyph (see below).
  // Kept so the Record stays total and a future reorder cannot silently leave a
  // slot without an icon.
  feed: null,
  market: (
    <>
      <path d="M3 17l6-6 4 4 7-7" />
      <path d="M17 8h4v4" />
    </>
  ),
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" />
      <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
    </>
  ),
};

const TABS: { key: Tab; label: string; href: string }[] = [
  { key: "agent", label: "Agent", href: "/agent" },
  { key: "wallet", label: "Wallet", href: "/wallet" },
  { key: "feed", label: "Feed", href: "/" },
  { key: "market", label: "Market", href: "/market" },
  { key: "chat", label: "Threads", href: "/chat" },
];

/**
 * Height the bar occupies, for callers that must not let content hide behind it.
 *
 * Exported rather than duplicated as a magic number: the feed pins a composer to
 * the bottom, and a padding value that drifts from the bar's real height puts the
 * post button underneath it — which is invisible in a screenshot and obvious the
 * moment somebody tries to post.
 */
export const BOTTOM_NAV_HEIGHT_CLASS = "pb-[calc(3.5rem+env(safe-area-inset-bottom))]";

/**
 * `inFlow` drops the fixed positioning so the bar sits as a normal last row of a
 * flex column — the feed's shape, where the scroll area ends above it and content
 * structurally cannot slip behind. Straight from bChat, which needed the same
 * escape hatch for the same reason. Standalone pages omit it and pad instead.
 */
export function BottomNav({ inFlow = false }: { inFlow?: boolean }) {
  const pathname = usePathname();

  return (
    <nav
      className={`z-50 border-t border-zinc-900 bg-black pb-[env(safe-area-inset-bottom)] ${
        inFlow ? "w-full shrink-0" : "fixed inset-x-0 bottom-0"
      }`}
      aria-label="Main"
    >
      <div className="mx-auto grid max-w-2xl grid-cols-5">
        {TABS.map(({ key, label, href }) => {
          // The feed is the root route, so a `startsWith` test would mark it
          // active on every page. It matches exactly; the others own their subtree.
          const active =
            href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
          const center = key === "feed";
          return (
            <a
              key={key}
              href={href}
              aria-current={active ? "page" : undefined}
              className="flex select-none flex-col items-center justify-center gap-1 py-2"
            >
              <span
                className={
                  center
                    ? `flex h-14 w-14 -mt-7 items-center justify-center rounded-full border shadow-lg shadow-black/60 transition-colors ${
                        active
                          ? "border-amber-400 bg-amber-500 text-black"
                          : "border-zinc-800 bg-black text-zinc-300"
                      }`
                    : `flex items-center justify-center transition-colors ${
                        active ? "text-amber-400" : "text-zinc-500"
                      }`
                }
              >
                {center ? (
                  // The wordmark, not a stroke glyph — same reasoning as bChat's
                  // `b` mark: the raised slot holds the product, not a category.
                  <span className="text-[19px] font-semibold leading-none tracking-tight">$</span>
                ) : (
                  <svg
                    width={20}
                    height={20}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {ICONS[key]}
                  </svg>
                )}
              </span>
              {/* NO LABEL UNDER THE CENTRE BUTTON — it would caption a mark that
                  already says what it is. The empty span is a SPACER, not an
                  oversight: without it the flex column re-centres and the raised
                  button sinks by half a label's height, breaking its alignment
                  with the bar. Straight from bChat, where the same bug happened. */}
              {center ? (
                <span aria-hidden className="block h-[11px]" />
              ) : (
                <span
                  className={`text-[9px] uppercase tracking-[0.18em] ${
                    active ? "text-amber-400" : "text-zinc-600"
                  }`}
                >
                  {label}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
