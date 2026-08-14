"use client";

import { useEffect, useRef, useState } from "react";
import { satsToDollars } from "@/hooks/useBsvPrice";

// Flashes within this window after mount are treated as page-load hydration
// (0 → existing total) and NOT flashed. A genuine earning arrives later (after a
// ≥30s poll), so it flashes — including a brand-new user's very FIRST earning,
// which the old `prev === 0` guard wrongly suppressed. (QA 2026-06-23)
const HYDRATION_GRACE_MS = 4000;

interface AnimatedBalanceProps {
  sats: number;
  bsvPrice?: number;
  isGoat?: boolean;
  className?: string;
  /**
   * Optional separate value that drives the flash + payout label.
   * When provided, the displayed number tracks `sats` but the flash/label only
   * fires when `flashTrigger` increases. Use this to flash on earnings while
   * displaying balance.
   */
  flashTrigger?: number;
}

export function AnimatedBalance({
  sats,
  bsvPrice = 50,
  isGoat = true,
  className = "",
  flashTrigger,
}: AnimatedBalanceProps) {
  const [displayed, setDisplayed] = useState(sats);
  const [flash, setFlash] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const prevSatsRef = useRef(sats);
  const prevFlashRef = useRef(flashTrigger ?? 0);
  const mountTimeRef = useRef(performance.now());
  const rafRef = useRef<number | null>(null);
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Count-up animation when sats changes
  useEffect(() => {
    const prev = prevSatsRef.current;
    const next = sats;
    prevSatsRef.current = sats;

    if (next === prev) return;

    // If no flashTrigger, don't animate at all (just snap)
    if (flashTrigger !== undefined) {
      setDisplayed(next);
      return;
    }

    // Legacy mode (no flashTrigger): animate count-up + flash on increase
    if (next <= prev) {
      setDisplayed(next);
      return;
    }

    const duration = 600;
    const start = performance.now();

    function step(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      setDisplayed(Math.round(prev + (next - prev) * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [sats, flashTrigger]);

  // Flash + label when flashTrigger increases (real earnings only)
  useEffect(() => {
    if (flashTrigger === undefined) return;

    const prev = prevFlashRef.current;
    const next = flashTrigger;
    prevFlashRef.current = next;

    if (next <= prev) return;
    // Skip only the page-load hydration flash; flash genuine later earnings
    // (incl. a new user's first), unlike the old `prev === 0` guard.
    if (performance.now() - mountTimeRef.current < HYDRATION_GRACE_MS) return;

    const delta = next - prev;
    const deltaDisplay = isGoat
      ? `+${delta.toLocaleString()} sats`
      : `+${satsToDollars(delta, bsvPrice)}`;

    setFlash(true);
    // Say what happened, not what to call it. This read "Agentic fairness",
    // inherited from OpenCook — a slogan on a payment notification, describing
    // the payout arithmetic rather than the event. Nobody watching their balance
    // move wants the name of the formula.
    setLabel(`${deltaDisplay} · your share`);
    setTimeout(() => setFlash(false), 1200);

    if (labelTimer.current) clearTimeout(labelTimer.current);
    labelTimer.current = setTimeout(() => setLabel(null), 3500);
  }, [flashTrigger, isGoat, bsvPrice]);

  const formattedValue = isGoat
    ? `${displayed.toLocaleString()} sats`
    : satsToDollars(displayed, bsvPrice);

  return (
    <span className="relative inline-flex items-center">
      <span
        className={`
          font-medium tabular-nums transition-all duration-300
          ${flash ? "text-amber-300 scale-110" : "text-amber-400 scale-100"}
          ${className}
        `}
        style={{ display: "inline-block", transformOrigin: "center" }}
      >
        {formattedValue}
      </span>

      {/* Payout label — see setLabel above */}
      {label && (
        <span
          className="absolute top-full right-0 mt-1 whitespace-nowrap text-[9px] text-amber-400/80 font-medium transition-opacity duration-500"
          aria-live="polite"
        >
          {label}
        </span>
      )}
    </span>
  );
}
