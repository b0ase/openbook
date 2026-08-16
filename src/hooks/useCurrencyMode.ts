"use client";

import { useCallback, useState } from "react";

export type CurrencyMode = "noob" | "goat";

const STORAGE_KEY = "openbook_currency_mode";

/**
 * Toggle between Noob Mode (dollars) and Goat Mode (sats).
 *
 * Default is ALWAYS dollars (Noob). Sats (Goat) is opt-in via the toggle; once
 * the user explicitly toggles, their choice is stored at STORAGE_KEY and
 * respected forever. There is NO protection-aware auto-flip to sats — defaulting
 * a freshly-protected user into sats "looked terrible" and contradicted the
 * dollars-default ethos (see DECISIONS "Currency default is always dollars").
 */
export function useCurrencyMode(): {
  mode: CurrencyMode;
  toggle: () => void;
  isGoat: boolean;
  hasUserChosen: boolean;
} {
  const [mode, setMode] = useState<CurrencyMode>(() => {
    if (typeof window === "undefined") return "noob";
    const stored = localStorage.getItem(STORAGE_KEY) as CurrencyMode | null;
    return stored === "noob" || stored === "goat" ? stored : "noob";
  });

  const [hasUserChosen, setHasUserChosen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) !== null;
  });

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next = prev === "noob" ? "goat" : "noob";
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
    setHasUserChosen(true);
  }, []);

  return {
    mode,
    toggle,
    isGoat: mode === "goat",
    hasUserChosen,
  };
}
