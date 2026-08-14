"use client";

import { useEffect, useState } from "react";
import { useInstallContext } from "@/contexts/InstallContext";
import { useInstallPlatform } from "@/hooks/useInstallPlatform";
import { useStandaloneMode } from "@/hooks/useStandaloneMode";
import { shouldShowInstallPitch } from "@/lib/install-pitch";

/**
 * Install bookmark — the minimised state of the install pitch. Sits in the
 * PostForm's footer row, centered (between the helper text on the left and
 * the Ask AI pill on the right). Tap to re-open the slide-up sheet
 * (`<InstallPitch variant="banner" />`).
 *
 * Design (border removed 2026-06-26):
 * - 30×30 OpenBook app icon as a BARE button — no zinc box (an app icon inside
 *   a zinc container looked odd). 34×34 tap target, `mt-1` baseline offset, so it
 *   still aligns with the Ask AI pill in the PostForm grid.
 * - Highlight flash on collapse from sheet → bookmark: an amber `drop-shadow`
 *   glow (follows the icon's rounded alpha, so it hugs the icon, not a square
 *   box) + scale-110, 2000ms. No pinging dot — the flash alone is a strong,
 *   quiet attention signal.
 *
 * Visibility = the 5-condition `shouldShowInstallPitch` gate PLUS
 * `installSheetMode === "bookmark"`. While the sheet is open or hidden,
 * this component renders nothing.
 */
export function InstallBookmark(): React.JSX.Element | null {
  const { installType } = useInstallPlatform();
  const standalone = useStandaloneMode();
  const {
    backedUp,
    protected: isProtected,
    engaged,
    installSheetMode,
    openSheetFromBookmark,
  } = useInstallContext();

  const visible = shouldShowInstallPitch({
    backedUp,
    protected: isProtected,
    standalone,
    installType,
    engaged,
  });

  // Ask-AI-style highlight flash — fires when the sheet collapses to here so
  // the user's eye tracks the destination. Watches installSheetMode so it
  // fires exactly once per "sheet → bookmark" transition.
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (installSheetMode !== "bookmark") return;
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2000);
    return () => clearTimeout(t);
  }, [installSheetMode]);

  if (!visible) return null;
  if (installSheetMode !== "bookmark") return null;

  return (
    <button
      type="button"
      onClick={openSheetFromBookmark}
      aria-label="Open install prompt"
      className={`h-[34px] w-[34px] flex items-center justify-center rounded-lg transition-all duration-200 mt-1 ${
        highlight
          ? "scale-110 drop-shadow-[0_0_10px_rgba(245,158,11,0.65)]"
          : "opacity-90 hover:opacity-100 hover:scale-105"
      }`}
    >
      {/* biome-ignore lint/performance/noImgElement: PWA icon path, no resize/CDN needed */}
      <img
        src="/icon-192.png"
        alt=""
        aria-hidden="true"
        width={30}
        height={30}
        className="rounded-lg"
      />
    </button>
  );
}
