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
 * ⚠ NEVER `position: fixed`. THE BAR VANISHED ON iOS IN STANDALONE PWA.
 *
 * The tab pages used to pin it with `fixed inset-x-0 bottom-0` and pad their
 * content by a `BOTTOM_NAV_HEIGHT_CLASS` to clear it. In an installed PWA on iOS
 * the bar simply DISAPPEARED on those pages, while the feed's — which already
 * sat in the flow — was fine. Both the fixed variant and the padding constant
 * are gone rather than left as options, because an option that only breaks in an
 * installed app on one platform is not one anybody will test before using it.
 *
 * Every page is now the feed's shape: a fixed-height flex column whose MIDDLE row
 * is the only thing that scrolls. The bar is the last row. Its position is then
 * structural rather than something a viewport can get wrong, and content cannot
 * slip behind it because the scroll region ends where the bar begins.
 */
export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="z-50 w-full shrink-0 border-t border-zinc-900 bg-black pb-[env(safe-area-inset-bottom)]"
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
                    ? `-mt-7 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border-2 shadow-lg shadow-black/60 transition-colors ${
                        // The icon supplies the colour, so active is a RING rather
                        // than a fill — filling it would hide the mark it exists
                        // to show.
                        active ? "border-amber-400" : "border-zinc-800"
                      }`
                    : `flex items-center justify-center transition-colors ${
                        active ? "text-amber-400" : "text-zinc-500"
                      }`
                }
              >
                {center ? (
                  // ⚠ THE ACTUAL PWA ICON, not a redrawing of part of it. The
                  // raised slot holds the product, and the strongest way to say
                  // "this app" is the same image the user tapped on their home
                  // screen. `icon.svg` is designed full-bleed precisely so any
                  // circular mask crops to solid amber, which is what this button
                  // is — so it needs no padding or background of its own.
                  /* biome-ignore lint/performance/noImgElement: a static local
                     icon at a fixed 56px; next/image would add a wrapper and a
                     request for an asset that is already exactly the right size
                     and is in the PWA manifest anyway. */
                  <img
                    src="/icon-192.png"
                    alt=""
                    width={56}
                    height={56}
                    className="h-full w-full object-cover"
                  />
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
