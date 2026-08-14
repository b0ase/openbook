"use client";

import { useEffect, useState } from "react";
import { InAppBrowserCta } from "@/components/InAppBrowserCta";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { detectMobileOS, type MobileOS } from "@/lib/in-app-browser";

/**
 * The read-only "open in your browser" prompt. Opens ONLY when a user in an
 * in-app WebView (read-only mode) attempts a WRITE action — post / boost /
 * reboot (via `requireIdentity()`), or the profile chip / "Add funds" (via the
 * explicit IdentityBar gates). Reading and scrolling never open it.
 *
 * Reuses `InAppBrowserCta` (Android Chrome-intent / iOS copy-link + paste).
 * Touches no identity/spend surfaces. Mounted once inside <IdentityProvider> in
 * Feed.tsx, beside <SignInModal>. Shell mirrors SignInModal/FundAddress.
 */
export function InAppPromptModal(): React.JSX.Element | null {
  const { inAppPromptOpen, closeInAppPrompt, dismissReadOnly } = useIdentityContext();
  const [os] = useState<MobileOS>(() =>
    typeof navigator !== "undefined" ? detectMobileOS(navigator.userAgent) : "other"
  );

  // Escape key closes (parity with SignInModal).
  useEffect(() => {
    if (!inAppPromptOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeInAppPrompt();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [inAppPromptOpen, closeInAppPrompt]);

  if (!inAppPromptOpen) return null;

  return (
    <>
      {/* Backdrop click closes */}
      <button
        type="button"
        className="fixed inset-0 z-[80] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out] cursor-default"
        aria-label="Close"
        onClick={closeInAppPrompt}
      />

      <div className="fixed inset-0 z-[80] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
        <div
          className="w-full max-w-sm rounded-2xl border border-amber-400/20 shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] overflow-y-auto"
          style={{ backgroundColor: "#0f0f0f" }}
        >
          {/* Gold top stripe */}
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
            <p className="text-sm font-semibold text-zinc-100">Open in your browser</p>
            <button
              type="button"
              onClick={closeInAppPrompt}
              className="text-zinc-500 hover:text-zinc-200 transition-colors ml-3"
              aria-label="Close"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Body — no crypto jargon ("account"/"earnings"). */}
          <div className="px-5 py-5 space-y-4">
            <p className="text-sm leading-relaxed text-zinc-300">
              This works best in your real browser. You&apos;re viewing inside an in-app browser —
              it can&apos;t keep your account between sessions, and any earnings won&apos;t travel
              with you. Open OpenBooks in your browser and your account is yours to keep.
            </p>
            <InAppBrowserCta os={os} />
            <button
              type="button"
              onClick={dismissReadOnly}
              className="block w-full text-center text-[11px] text-zinc-600 hover:text-zinc-400 underline underline-offset-2 transition-colors"
            >
              Not in an in-app browser? Continue anyway.
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
