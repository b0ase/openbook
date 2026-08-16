"use client";

import { useEffect, useState } from "react";

const DISMISSED_UNTIL_KEY = "openbook_first_earning_save_dismissed_until";
const HOUR_MS = 60 * 60 * 1000;
const BACKOFF_HOURS = 48;

interface FirstEarningToastProps {
  /** Live earnings total from `/api/earnings` polling. Null = pre-hydration. */
  earnedSats: number | null;
  /** Live 0-conf pending balance from `/api/balance`. Null = pre-hydration. */
  pendingSats: number | null;
  /** Whether the user has saved their recovery file. Null = pre-hydration. */
  backedUp: boolean | null;
  /**
   * Fired when the user taps "Save now". Should open the You modal so the
   * user lands on the orange "Save your recovery file" CTA (works for both
   * protected and unprotected users — handleSaveFile direct-call doesn't work
   * for protected users without the manage gate).
   */
  onSaveNow: () => void;
}

function readDismissedUntil(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(DISMISSED_UNTIL_KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeDismissedUntil(value: number): void {
  try {
    window.localStorage.setItem(DISMISSED_UNTIL_KEY, String(value));
  } catch {
    // localStorage write failed — toast still hides this session via state.
  }
}

/**
 * One-time celebratory toast on the user's first non-zero earnings. Prompts
 * them to save their recovery file before they lose access to those sats with
 * the device.
 *
 * Trigger: `earnedSats > 0 && backedUp === false && dismissed_until < now`.
 *
 * Both buttons set `dismissed_until = now + 48h`. "Save now" also fires
 * `onSaveNow` to open ProtectModal directly (the add-a-passphrase flow). If the user completes the save,
 * `backedUp` flips true and the toast never re-evaluates true again. If they
 * abandon mid-flow, the 48h backoff still applies — toast can return later
 * (high-stakes prompt deserves gentle re-attempt, not a one-shot per
 * LAUNCH_PLAN decision #4).
 */
export function FirstEarningToast({
  earnedSats,
  pendingSats,
  backedUp,
  onSaveNow,
}: FirstEarningToastProps): React.JSX.Element | null {
  const [animateIn, setAnimateIn] = useState(false);
  // Local "dismissed this session" — toast unmounts on next render without
  // waiting for the next poll to re-evaluate dismissed_until.
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  // Visibility check runs on every change to earnedSats / backedUp.
  useEffect(() => {
    if (sessionDismissed) {
      setVisible(false);
      return;
    }
    if (earnedSats === null || backedUp === null) {
      setVisible(false);
      return;
    }
    if (earnedSats <= 0) {
      setVisible(false);
      return;
    }
    if (backedUp) {
      setVisible(false);
      return;
    }
    // Up to 30s latency between dismissed_until expiry and toast re-firing —
    // the effect deps don't include time, so we wait for the next 30s earnings
    // poll to re-set earnedSats and re-trigger the effect. Acceptable for a
    // gentle 48h backoff prompt; not worth a setInterval just for re-eval.
    if (readDismissedUntil() > Date.now()) {
      setVisible(false);
      return;
    }
    // Wait until the chip has actually updated before prompting to save — the
    // user should SEE the money land first. The 0-conf "+pending" shows within
    // seconds (the balance is refetched the moment earnings land); once it's
    // visible we fire ~600ms later. If pending never appears (e.g. the balance
    // was already confirmed, so pending stays 0) an 8s fallback still fires so
    // the prompt can't be suppressed indefinitely. Gating on PENDING (0-conf,
    // seconds) — NOT block confirmation (~10min) — stays on the right side of
    // "fire on earning, not confirmation". (QA 2026-06-25)
    const pendingVisible = pendingSats !== null && pendingSats > 0;
    const t = setTimeout(() => setVisible(true), pendingVisible ? 600 : 8000);
    return () => clearTimeout(t);
  }, [earnedSats, pendingSats, backedUp, sessionDismissed]);

  // Slide-up animation — same pattern as the other transient toasts.
  useEffect(() => {
    if (!visible) {
      setAnimateIn(false);
      return;
    }
    const t = setTimeout(() => setAnimateIn(true), 16);
    return () => clearTimeout(t);
  }, [visible]);

  function handleSaveNow(): void {
    // Set 48h backoff BEFORE opening the modal — if the user abandons mid-save,
    // they get a 48h reprieve, not a re-fire on the next 30s poll (the
    // architect's correction on LAUNCH_PLAN intent).
    writeDismissedUntil(Date.now() + BACKOFF_HOURS * HOUR_MS);
    setSessionDismissed(true);
    onSaveNow();
  }

  function handleLater(): void {
    writeDismissedUntil(Date.now() + BACKOFF_HOURS * HOUR_MS);
    setSessionDismissed(true);
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 w-[calc(100vw-2rem)] max-w-sm transition-all duration-300 ${
        animateIn ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <div className="rounded-2xl border border-amber-400/40 bg-zinc-900 px-4 py-3 shadow-lg">
        <p className="text-sm text-amber-300 font-medium">You just got paid.</p>
        <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
          Save your recovery file — it&apos;s your only way back in if you lose this device.
        </p>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={handleSaveNow}
            className="flex-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-lg px-3 py-2.5 text-[12px] font-medium hover:bg-amber-500/30 transition-colors"
          >
            Save now
          </button>
          <button
            type="button"
            onClick={handleLater}
            className="flex-1 bg-transparent text-zinc-400 border border-zinc-700 rounded-lg px-3 py-2.5 text-[12px] font-medium hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
