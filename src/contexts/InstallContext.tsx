"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { isEffectivelyProtected } from "@/services/bsv/identity";

const ENGAGED_KEY = "openbook_install_engaged";
const BACKED_UP_KEY = "openbook_identity_backed_up";
const SHEET_SHOWN_KEY = "openbook_install_sheet_shown"; // sessionStorage
const SHEET_DELAY_MS = 800;

/**
 * Install pitch mode — drives which surface (sheet vs bookmark) is currently
 * rendered when the user passes the visibility gate.
 *
 * - `"hidden"` — initial state; no surface visible. Used both before gate
 *   passes (no recovery file yet, etc.) AND during the first 800ms after the
 *   gate passes (gives the user a moment to land on the page).
 * - `"sheet"` — full slide-up sheet. The big-impact post-save moment.
 * - `"bookmark"` — minimised state. Small app-icon button in PostForm's row
 *   next to Ask AI. Quietly visible, tap to re-open.
 */
export type InstallSheetMode = "hidden" | "sheet" | "bookmark";

interface InstallContextValue {
  /** True if a `beforeinstallprompt` event was captured and hasn't been consumed. */
  canPromptInstall: boolean;
  /**
   * Fire the captured deferred prompt. Returns the user's outcome, or `null`
   * if no prompt is available (e.g., on iOS where `beforeinstallprompt` never
   * fires). Defensive-return matches `requireIdentity()` — callers narrow with
   * `if (outcome === null) return;` rather than try/catch.
   *
   * Outcome handling (revised 2026-06-03):
   * - `"accepted"` → set `engaged = true` permanently. The browser will fire
   *   `appinstalled` shortly; the engaged flag bridges the gap between accept
   *   and standalone-mode-detection in the lingering tab.
   * - `"dismissed"` → NO suppression. The native OS prompt cancel is the tail
   *   of an engagement we delivered, not a rejection of our pitch. The browser
   *   self-regulates `beforeinstallprompt` re-fire cadence anyway; the
   *   deferred event is consumed regardless. Hiding the install path on
   *   native cancel was an implementation conflation with the X-tap
   *   suppression that no longer exists (X-tap was replaced with
   *   chevron-minimise-to-bookmark 2026-06-02).
   */
  promptInstall: () => Promise<"accepted" | "dismissed" | null>;
  /**
   * True if the user has engaged with the install flow — either accepted the
   * native prompt OR `appinstalled` event fired. Permanent suppression. The
   * gate's main suppression mechanism after the 30-day timer was removed
   * (2026-06-03). Mostly covers the "lingering browser tab after install"
   * edge case; the `standalone` gate handles all other post-install loads.
   */
  engaged: boolean;
  /** Mark the user as having engaged the install path. Permanent. */
  markEngaged: () => void;
  /**
   * True if the user has saved a recovery file at least once (mirrored from
   * the `openbook_identity_backed_up` localStorage flag). The install pitch is
   * gated on this — without a recovery file, a fresh install lands in a new
   * sandbox with no recovery path. Source of truth for the trigger.
   */
  backedUp: boolean;
  /**
   * Mark the user as having saved a recovery file. Writes localStorage AND
   * updates context state so the bottom banner can react mid-session (without
   * this, the banner would only appear on the next page load). Idempotent.
   */
  markBackedUp: () => void;
  /**
   * True if the user's identity is passphrase-encrypted. Mirrors
   * `isEffectivelyProtected()` from `services/bsv/identity.ts` so the install
   * pitch gate can re-render when protection state changes (after protecting
   * via ProtectModal / changing passphrase via ChangePassphraseModal, or after
   * encrypted restore via RestoreModal). Initial value read synchronously on
   * mount; refreshed when `refreshProtected()` is called (after any of those
   * flows complete) and when a `storage` event fires for the encrypted-key
   * localStorage entry (cross-tab restore).
   */
  protected: boolean;
  /**
   * Force a re-read of `isEffectivelyProtected()` and update context state.
   * Called by ProtectModal / ChangePassphraseModal / RestoreModal after their
   * key write (encrypt-in-place / encrypted restore) completes — those
   * operations write localStorage but don't fire a `storage` event in the
   * same tab.
   */
  refreshProtected: () => void;
  /** Current install pitch surface — see `InstallSheetMode`. */
  installSheetMode: InstallSheetMode;
  /**
   * Called by `InstallPitch` once it determines the visibility gate has passed
   * for the first time this session. Idempotent — re-calls are no-ops.
   */
  initializeSheetMode: () => void;
  /** Chevron tap on the sheet — minimises to the bookmark. */
  minimiseToBookmark: () => void;
  /** Bookmark tap — re-opens the sheet (slideUp animation). */
  openSheetFromBookmark: () => void;
  /**
   * Ref-counted block on the install-pitch sheet appearance — mirror of the
   * `blockSessionClear` pattern in IdentityContext. Used by identity modals
   * (ProtectModal / ChangePassphraseModal / RestoreModal) to suppress the
   * sheet during their lifecycle. Modals mount → `blockInstallPitch()`,
   * unmount → `unblockInstallPitch()`. Once the count returns to zero, the
   * install pitch's gate re-evaluates and fires the sheet at a clean moment.
   */
  blockInstallPitch: () => void;
  unblockInstallPitch: () => void;
  /** Reader for the block ref — true if any modal is currently blocking the pitch. */
  isInstallPitchBlocked: () => boolean;
  /** Tick that increments whenever the block count returns to zero. */
  installPitchBlockTick: number;
}

const InstallContext = createContext<InstallContextValue | null>(null);

function readEngaged(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ENGAGED_KEY) === "1";
  } catch {
    return false;
  }
}

function readBackedUp(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BACKED_UP_KEY) === "1";
  } catch {
    return false;
  }
}

function readProtected(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return isEffectivelyProtected();
  } catch {
    return false;
  }
}

export function InstallProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [canPromptInstall, setCanPromptInstall] = useState(false);
  const [engaged, setEngaged] = useState<boolean>(() => readEngaged());
  const [backedUp, setBackedUp] = useState<boolean>(() => readBackedUp());
  const [installSheetMode, setInstallSheetMode] = useState<InstallSheetMode>("hidden");
  const [protectedState, setProtectedState] = useState<boolean>(() => readProtected());
  const [installPitchBlockTick, setInstallPitchBlockTick] = useState(0);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  // initializeSheetMode is callable many times across re-renders but should
  // only do its first-pass logic ONCE. Ref-guarded so React Strict Mode's
  // double-invoke can't cause a double-fire of the sessionStorage write or
  // the 800ms timer.
  const sheetInitRef = useRef(false);
  const sheetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref-counted block — modal mount → +1, unmount → -1. When count returns
  // to 0, install pitch can fire. Tick state increments on the 0-edge so
  // consumers in the React tree re-evaluate.
  const installPitchBlockRef = useRef(0);

  // Capture beforeinstallprompt + appinstalled events
  useEffect(() => {
    function handleBeforeInstallPrompt(e: BeforeInstallPromptEvent): void {
      e.preventDefault();
      deferredPromptRef.current = e;
      setCanPromptInstall(true);
    }

    function handleAppInstalled(): void {
      deferredPromptRef.current = null;
      setCanPromptInstall(false);
      window.localStorage.setItem(ENGAGED_KEY, "1");
      setEngaged(true);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | null> => {
    const deferred = deferredPromptRef.current;
    if (!deferred) return null;
    try {
      await deferred.prompt();
      const result = await deferred.userChoice;
      // Deferred event is single-use per spec — clear regardless of outcome.
      deferredPromptRef.current = null;
      setCanPromptInstall(false);
      if (result.outcome === "accepted") {
        window.localStorage.setItem(ENGAGED_KEY, "1");
        setEngaged(true);
      }
      // Dismissed outcome: no suppression. User cancelled the OS dialog;
      // browser will not re-fire beforeinstallprompt immediately (it
      // self-regulates), and the deferred event is consumed. Pitch stays
      // findable for when the user is ready. See DECISIONS.md "Install
      // pitch — no timer-based suppression" (revised 2026-06-03).
      return result.outcome;
    } catch {
      // Browser refused to show prompt (rare — e.g., already in flight). Treat
      // as "no outcome" — caller can retry, no suppression applied.
      return null;
    }
  }, []);

  const markEngaged = useCallback((): void => {
    try {
      window.localStorage.setItem(ENGAGED_KEY, "1");
    } catch {
      // localStorage write failed (private browsing quota, etc.) — still flip
      // in-memory so the banner reacts this session.
    }
    setEngaged(true);
  }, []);

  const markBackedUp = useCallback((): void => {
    try {
      window.localStorage.setItem(BACKED_UP_KEY, "1");
    } catch {
      // localStorage write failed (private browsing quota, etc.) — still flip
      // in-memory so the banner reacts this session.
    }
    setBackedUp(true);
  }, []);

  const refreshProtected = useCallback((): void => {
    setProtectedState(readProtected());
  }, []);

  // Cross-tab protection sync — storage events fire when ANOTHER tab writes
  // to localStorage. Same-tab writes (after rotation flow) don't fire
  // `storage`, so those modals must call `refreshProtected()` explicitly
  // after their commit step.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function handleStorage(e: StorageEvent): void {
      if (e.key === "bfn_keypair" || e.key === "bfn_keypair_enc") {
        setProtectedState(readProtected());
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const initializeSheetMode = useCallback((): void => {
    if (sheetInitRef.current) return;
    sheetInitRef.current = true;
    // Atomically set the sessionStorage flag BEFORE scheduling the 800ms reveal.
    // If the user hard-reloads during the 800ms window, we want the next mount
    // to land on "bookmark" (flag already set), not on a fresh "sheet" — that
    // would double-fire the impactful surface.
    try {
      if (window.sessionStorage.getItem(SHEET_SHOWN_KEY)) {
        setInstallSheetMode("bookmark");
        return;
      }
      window.sessionStorage.setItem(SHEET_SHOWN_KEY, "1");
    } catch {
      // sessionStorage blocked (private mode / quota). Fall through to the
      // 800ms timer — user gets the sheet, no flag persisted. Slightly worse
      // than ideal but no crash.
    }
    // The 800ms reveal must re-check the modal-block at FIRE time, not just when it
    // was armed: the unblock that armed this timer (e.g. ProtectModal unmounting)
    // can race the You-modal's own close, so a modal / just-saved flow may still be
    // on screen 800ms later. If still blocked, wait another beat and re-check — so
    // the sheet never slides up over the passphrase create+save flow (owner-reported
    // "add-to-home-screen popup shows at the same time the user saves").
    const fire = (): void => {
      if (installPitchBlockRef.current > 0) {
        sheetTimerRef.current = setTimeout(fire, SHEET_DELAY_MS);
        return;
      }
      setInstallSheetMode("sheet");
      sheetTimerRef.current = null;
    };
    sheetTimerRef.current = setTimeout(fire, SHEET_DELAY_MS);
  }, []);

  const minimiseToBookmark = useCallback((): void => {
    if (sheetTimerRef.current !== null) {
      clearTimeout(sheetTimerRef.current);
      sheetTimerRef.current = null;
    }
    setInstallSheetMode("bookmark");
  }, []);

  const openSheetFromBookmark = useCallback((): void => {
    setInstallSheetMode("sheet");
  }, []);

  const blockInstallPitch = useCallback((): void => {
    installPitchBlockRef.current += 1;
  }, []);

  const unblockInstallPitch = useCallback((): void => {
    installPitchBlockRef.current = Math.max(0, installPitchBlockRef.current - 1);
    if (installPitchBlockRef.current === 0) {
      setInstallPitchBlockTick((t) => t + 1);
    }
  }, []);

  const isInstallPitchBlocked = useCallback((): boolean => {
    return installPitchBlockRef.current > 0;
  }, []);

  // Clean up any pending timer on provider unmount (HMR, route change).
  useEffect(() => {
    return () => {
      if (sheetTimerRef.current !== null) {
        clearTimeout(sheetTimerRef.current);
        sheetTimerRef.current = null;
      }
    };
  }, []);

  return (
    <InstallContext.Provider
      value={{
        canPromptInstall,
        promptInstall,
        engaged,
        markEngaged,
        backedUp,
        markBackedUp,
        protected: protectedState,
        refreshProtected,
        installSheetMode,
        initializeSheetMode,
        minimiseToBookmark,
        openSheetFromBookmark,
        blockInstallPitch,
        unblockInstallPitch,
        isInstallPitchBlocked,
        installPitchBlockTick,
      }}
    >
      {children}
    </InstallContext.Provider>
  );
}

export function useInstallContext(): InstallContextValue {
  const ctx = useContext(InstallContext);
  if (!ctx) {
    throw new Error("useInstallContext must be used within InstallProvider");
  }
  return ctx;
}
