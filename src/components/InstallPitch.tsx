"use client";

import { useEffect, useRef, useState } from "react";
import { useInstallContext } from "@/contexts/InstallContext";
import { type InstallPlatform, useInstallPlatform } from "@/hooks/useInstallPlatform";
import { useStandaloneMode } from "@/hooks/useStandaloneMode";
import { shouldShowInstallPitch } from "@/lib/install-pitch";

/**
 * Duration of the sheet-to-bookmark collapse animation. Must match the
 * `collapseToBookmark` keyframe duration in `globals.css` (currently 0.3s).
 * The actual mode flip from "sheet" → "bookmark" fires `COLLAPSE_MS` after
 * the chevron tap so the exit animation runs to completion before the sheet
 * unmounts and the bookmark appears.
 */
const COLLAPSE_MS = 300;

interface InstallPitchProps {
  /**
   * `"inline"` — embeds inside the You modal done-state (no chevron, no
   * minimise — the user already actively triggered this view by saving their
   * key). Always renders the compact strip shape; never the slide-up sheet.
   *
   * `"banner"` — drives the global slide-up sheet / bookmark interaction.
   * Mounts once per app, reads `installSheetMode` from `InstallContext`. When
   * `installSheetMode === "sheet"`, renders the slide-up sheet. When mode is
   * `"bookmark"` or `"hidden"`, renders nothing — the bookmark itself is
   * rendered by `<InstallBookmark />` next to the bopen.ai link in `Feed.tsx`.
   */
  variant: "inline" | "banner";
}

/**
 * Install pitch sheet — full-impact slide-up surface for the first-tab-session
 * appearance after a recovery file save. See LAUNCH_PLAN.md decision #10 +
 * DECISIONS.md "Install pitch surfaces — no timer-based dismissal".
 *
 * Visibility is a 5-condition gate (see `shouldShowInstallPitch`): backed up
 * AND protected AND not standalone AND supported platform AND not engaged.
 * Returns `null` when any condition fails.
 *
 * State machine (per-session-per-tab, lives in `InstallContext`):
 * - `"hidden"` → initial. While the gate is closed OR during the 800ms reveal
 *   delay after the gate opens.
 * - `"sheet"` → after the 800ms reveal: the slide-up sheet. Chevron tap →
 *   `"bookmark"`.
 * - `"bookmark"` → the minimised state. Sheet not rendered; a small icon
 *   centered in the PostForm footer row signals the install pitch is still
 *   available. Tap the bookmark → back to `"sheet"`. There is NO timer-based
 *   dismissal anywhere — the bookmark IS the persistent reminder, and the
 *   visibility gate self-resolves on install (`appinstalled` → `engaged`).
 *
 * Platform branching (from `useInstallPlatform`):
 * - `one-tap` (Android Chrome/Brave/Edge/Samsung, desktop Chrome/Edge) — real
 *   button calling `promptInstall()`. Accepted outcome → `engaged` flag set
 *   (gate closes). Dismissed outcome → no-op; browser self-regulates re-fire
 *   cadence for `beforeinstallprompt`.
 * - `manual-instructions` — iOS Safari, desktop Safari, Firefox Android.
 *   Visual instructions with the platform's actual install steps. iOS gets
 *   inline pill labels with Share + Add-to-Home-Screen icons + "scroll down"
 *   cue between them (Add-to-Home-Screen is below the fold in iOS Share).
 * - `open-in-safari` — iOS Chrome/Brave/Firefox/Edge. WebKit-wrapped browsers
 *   can't install PWAs on iOS; nudge user to open in Safari first.
 *
 * iOS Safari has no `appinstalled` event, but self-corrects: after the user
 * adds to home screen and opens from the icon, `detectStandalone() === true`,
 * the gate fails, the pitch hides forever on that device. Do NOT add a phantom
 * engagement tracker for iOS — the standalone gate IS the suppression.
 */
export function InstallPitch({ variant }: InstallPitchProps): React.JSX.Element | null {
  const { platform, installType } = useInstallPlatform();
  const standalone = useStandaloneMode();
  const {
    backedUp,
    protected: isProtected,
    engaged,
    canPromptInstall,
    promptInstall,
    installSheetMode,
    initializeSheetMode,
    openSheetFromBookmark,
    minimiseToBookmark,
    isInstallPitchBlocked,
    installPitchBlockTick,
  } = useInstallContext();

  const visible = shouldShowInstallPitch({
    backedUp,
    protected: isProtected,
    standalone,
    installType,
    engaged,
  });

  // Banner only — kick off the mode initialisation (sessionStorage check +
  // 800ms reveal) once visibility opens up AND no identity modal is currently
  // blocking. `installPitchBlockTick` increments when the block count returns
  // to 0, forcing this effect to re-fire so the pitch lands at a clean moment
  // (after the user dismisses their ProtectModal / ChangePassphraseModal
  // / RestoreModal done state). The block ref itself isn't React state — the
  // tick is the React-observable proxy.
  // installPitchBlockTick is intentionally in the dep array — it's the
  // React-observable signal that the ref-counted block has changed. Without
  // it the effect wouldn't re-fire when a rotation modal unmounts and
  // releases the block. `isInstallPitchBlocked` is a stable useCallback that
  // reads the ref; the tick is what re-evaluates the gate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (variant !== "banner" || !visible) return;
    if (isInstallPitchBlocked()) return; // a rotation modal is active — wait
    initializeSheetMode();
  }, [variant, visible, initializeSheetMode, isInstallPitchBlocked, installPitchBlockTick]);

  // Local collapse animation state — fires when user taps the chevron. The
  // sheet renders the `collapseToBookmark` keyframe during this window, then
  // we flip context mode to "bookmark" so the sheet unmounts and the
  // <InstallBookmark /> in Feed.tsx fades in at its destination position.
  // Local (not context) state because only the sheet needs to render the
  // exit animation — once unmounted, no consumer cares about the transient.
  const [collapsing, setCollapsing] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, []);

  if (!visible) return null;

  async function handleInstallTap(): Promise<void> {
    if (!canPromptInstall) return;
    await promptInstall();
    // promptInstall sets `engaged` on accepted; dismissed is a no-op (browser
    // self-regulates beforeinstallprompt re-fire cadence).
  }

  function handleChevronTap(): void {
    if (collapsing) return; // ignore double-tap during animation
    setCollapsing(true);
    collapseTimerRef.current = setTimeout(() => {
      minimiseToBookmark();
      setCollapsing(false);
      collapseTimerRef.current = null;
    }, COLLAPSE_MS);
  }

  // ─── Inline variant (inside You modal) ─────────────────────────────────────
  // Whole row is clickable. On one-tap platforms (Android Chrome / desktop
  // Chrome with `beforeinstallprompt` captured) tapping fires `promptInstall`
  // directly — single tap → native install dialog. On manual-instructions /
  // open-in-safari / unsupported platforms the row opens the slide-up sheet
  // which carries the platform-specific instructions. Trailing chevron-right
  // signals tappability in both cases.
  if (variant === "inline") {
    const isOneTap = installType === "one-tap" && canPromptInstall;
    return (
      <button
        type="button"
        onClick={isOneTap ? handleInstallTap : openSheetFromBookmark}
        aria-label={isOneTap ? "Install OpenBooks" : "Open install prompt"}
        className="w-full text-left px-3 py-2.5 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-3 hover:bg-amber-500/15 active:bg-amber-500/20 transition-colors"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-amber-400 shrink-0"
        >
          <title>Install</title>
          <path d="M12 2v8" />
          <path d="m16 6-4 4-4-4" />
          <rect x="3" y="14" width="18" height="8" rx="2" />
        </svg>
        <div className="flex-1 min-w-0">
          {renderStripContent(installType, platform, canPromptInstall, handleInstallTap)}
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-zinc-500 shrink-0"
        >
          <title>Open</title>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    );
  }

  // ─── Banner variant — only render when mode is "sheet" ─────────────────────
  // "hidden" → nothing yet (initial / during 800ms delay).
  // "bookmark" → nothing here; <InstallBookmark /> handles that surface.
  if (installSheetMode !== "sheet") return null;

  // Sheet entrance vs collapse animation. The slide-up keyframe runs on
  // mount; the collapse keyframe replaces it during the chevron-tap exit.
  const sheetAnimation = collapsing
    ? "animate-[collapseToBookmark_0.3s_ease-in_forwards]"
    : "animate-[slideUp_0.35s_ease-out_backwards]";
  const backdropAnimation = collapsing
    ? "animate-[fadeOut_0.3s_ease-in_forwards]"
    : "animate-[fadeIn_0.2s_ease-out]";

  return (
    <>
      <button
        type="button"
        className={`fixed inset-0 z-[70] w-full bg-black/30 backdrop-blur-[2px] cursor-default ${backdropAnimation}`}
        aria-label="Minimise install prompt"
        onClick={handleChevronTap}
      />
      <div className="fixed inset-x-0 bottom-0 z-[70] flex justify-center pointer-events-none">
        <div
          className={`w-full max-w-lg rounded-t-2xl border-t border-x border-amber-400/20 shadow-[0_-8px_40px_rgba(0,0,0,0.7)] overflow-hidden pointer-events-auto bg-zinc-900 ${sheetAnimation}`}
          role="dialog"
          aria-modal="true"
          aria-label="Install OpenBooks"
        >
          {/* Gold top stripe — same as SignInModal / FundAddress */}
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />

          {/* Chevron-down (minimise) at top center. There is no X — the only
              way out of the sheet is minimise-to-bookmark. The bookmark in
              PostForm is the persistent reminder. */}
          <div className="flex justify-center pt-2 pb-1">
            <button
              type="button"
              onClick={handleChevronTap}
              aria-label="Minimise install prompt"
              className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="px-6 pb-6 pt-1 text-center">
            {/* 64px OpenBooks app icon — the actual home-screen preview, with
                amber glow shadow so it reads as "premium" without shouting.
                Static (the prior floatBob animation was removed per project
                owner — implied false affordance on a non-interactive element).
                Decorative — aria-hidden because the headline does the lifting. */}
            {/* biome-ignore lint/performance/noImgElement: PWA icon path, no resize/CDN needed */}
            <img
              src="/icon-192.png"
              alt=""
              aria-hidden="true"
              width={64}
              height={64}
              className="rounded-xl mx-auto mb-4 shadow-[0_4px_16px_rgba(245,158,11,0.25)]"
            />
            {/* Headline — DECISIONS.md "Notification copy discipline" rule
                allows the install-pitch headline to diverge from the literal
                push-permission copy. "Get the APP experience" is direct,
                category-naming, no hedging. Single-line discipline preserved. */}
            <p className="text-lg font-semibold text-amber-400 leading-snug mb-5">
              Get the APP experience
            </p>
            <div className="space-y-3">
              {renderSheetCTA(installType, platform, canPromptInstall, handleInstallTap)}
            </div>
          </div>
          {/* iOS home-indicator safe-area */}
          <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />
        </div>
      </div>
    </>
  );
}

/**
 * Sheet-scale CTA — larger touch targets, richer typography. Each platform
 * branch produces the right action shape for its install path.
 */
function renderSheetCTA(
  installType: ReturnType<typeof useInstallPlatform>["installType"],
  platform: InstallPlatform | null,
  canPromptInstall: boolean,
  handleInstallTap: () => Promise<void>
): React.JSX.Element {
  if (installType === "one-tap") {
    if (!canPromptInstall) {
      const fallback =
        platform === "android"
          ? "Open your browser menu, then choose Install."
          : "Open your browser menu, then choose Install app.";
      return <p className="text-[13px] text-zinc-400 leading-relaxed">{fallback}</p>;
    }
    return (
      <button
        type="button"
        onClick={handleInstallTap}
        className="w-full bg-amber-500 text-black rounded-xl px-4 py-3 text-sm font-semibold hover:bg-amber-400 active:bg-amber-600 transition-colors"
      >
        Add to home
      </button>
    );
  }

  if (installType === "manual-instructions") {
    if (platform === "ios-safari") {
      // iOS Share sheet places "Add to Home Screen" BELOW the visible fold —
      // users frequently miss it without an explicit scroll-down cue. The
      // small parenthetical sits between the Share and Add-to-Home-Screen
      // pills at exactly the point the user needs the hint. Pill-shaped
      // labels mirror iOS button visual treatment so the user is matching
      // shapes between sheet and Safari chrome.
      return (
        <div className="flex flex-col items-center gap-2 text-sm text-zinc-400">
          <div className="inline-flex items-center gap-2">
            <span>Tap</span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-medium">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 12H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-5" />
                <line x1="12" y1="2" x2="12" y2="15" />
                <polyline points="8 6 12 2 16 6" />
              </svg>
              Share
            </span>
          </div>
          <p className="flex items-center justify-center gap-1 text-[11px] text-zinc-300 leading-relaxed">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0 text-amber-400/70"
            >
              <title>Scroll down</title>
              <line x1="12" y1="2" x2="12" y2="22" />
              <polyline points="19 15 12 22 5 15" />
            </svg>
            scroll down to find it
          </p>
          <div className="inline-flex items-center gap-2">
            <span>then tap</span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-medium">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              Add to Home Screen
            </span>
          </div>
        </div>
      );
    }
    if (platform === "desktop-safari") {
      return (
        <p className="text-[13px] text-zinc-400 leading-relaxed">
          Open the <span className="text-zinc-200">File</span> menu, then{" "}
          <span className="text-zinc-200">Add to Dock</span>.
        </p>
      );
    }
    return (
      <p className="text-[13px] text-zinc-400 leading-relaxed">
        Open your browser menu, then <span className="text-zinc-200">Install</span>.
      </p>
    );
  }

  if (installType === "open-in-safari") {
    return (
      <p className="text-[13px] text-zinc-400 leading-relaxed">
        Open OpenBooks in <span className="text-zinc-200">Safari</span> to add it to your home
        screen.
      </p>
    );
  }

  // installType === "unsupported" or null — should never reach here.
  return <span className="text-[13px] text-zinc-400">Get the APP experience</span>;
}

/**
 * Strip-scale content — used ONLY by the inline variant (inside You modal
 * done-state). The banner variant no longer falls back to a compact strip —
 * the bookmark in Feed.tsx is the second-impression surface now.
 */
function renderStripContent(
  installType: ReturnType<typeof useInstallPlatform>["installType"],
  platform: InstallPlatform | null,
  canPromptInstall: boolean,
  _handleInstallTap: () => Promise<void>
): React.JSX.Element {
  if (installType === "one-tap") {
    if (!canPromptInstall) {
      const fallback =
        platform === "android"
          ? "Open the browser menu, then Install."
          : "Open the browser menu, then Install app.";
      return (
        <div className="space-y-1">
          <span className="text-[12px] text-amber-400 font-medium block">
            Get the APP experience
          </span>
          <span className="text-[11px] text-zinc-400 block">{fallback}</span>
        </div>
      );
    }
    // Visual-only label — the outer inline `<button>` (in the inline variant
    // above) is the actual tap target. A nested <button> here would produce
    // invalid HTML. The user's tap opens the slide-up sheet which has its own
    // real install button calling `promptInstall`.
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-amber-400 font-medium">Get the APP experience</span>
        <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-lg px-3 py-1.5 text-[11px] font-medium">
          Add to home
        </span>
      </div>
    );
  }

  if (installType === "manual-instructions") {
    const instructions =
      platform === "ios-safari" ? (
        <span className="text-[11px] text-zinc-400 block">
          Tap{" "}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="inline-block text-zinc-300"
            style={{ verticalAlign: "-2px" }}
          >
            <path d="M9 12H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-5" />
            <line x1="12" y1="2" x2="12" y2="15" />
            <polyline points="8 6 12 2 16 6" />
          </svg>{" "}
          Share, then{" "}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="inline-block text-zinc-300"
            style={{ verticalAlign: "-2px" }}
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>{" "}
          Add to Home Screen.
        </span>
      ) : platform === "desktop-safari" ? (
        <span className="text-[11px] text-zinc-400 block">Open File menu → Add to Dock.</span>
      ) : (
        <span className="text-[11px] text-zinc-400 block">
          Open the browser menu, then Install.
        </span>
      );
    return (
      <div className="space-y-1">
        <span className="text-[12px] text-amber-400 font-medium block">Get the APP experience</span>
        {instructions}
      </div>
    );
  }

  if (installType === "open-in-safari") {
    return (
      <div className="space-y-1">
        <span className="text-[12px] text-amber-400 font-medium block">Get the APP experience</span>
        <span className="text-[11px] text-zinc-400 block">
          Open OpenBooks in Safari to install.
        </span>
      </div>
    );
  }

  return <span className="text-[12px] text-zinc-400">Get the APP experience</span>;
}
