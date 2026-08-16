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
import { useIdentity } from "@/hooks/useIdentity";
import { detectStandalone } from "@/hooks/useStandaloneMode";
import { isInAppBrowserClient } from "@/lib/in-app-browser";
import { clearSessionCaches, getIdentity, importEncryptedIdentity } from "@/services/bsv/identity";
import type { Identity } from "@/types";

interface IdentityContextValue {
  identity: Identity | null;
  isLoading: boolean;
  needsUnlock: boolean;
  /**
   * True when running in standalone (installed PWA) mode AND no identity exists.
   * The wrapper renders `<HomeScreenWelcomeGate>` instead of the feed when true.
   * See LAUNCH_PLAN.md sequencing revision (2026-05-11) + DECISIONS.md
   * "Welcome gate fires when standalone-mode + no identity."
   */
  awaitingWelcomeGate: boolean;
  sign: (content: string) => Promise<{ signature: string; pubkey: string } | null>;
  updateIdentity: (newIdentity: Identity) => void;
  /**
   * SINGLE entry point for the welcome gate to commit a restored identity.
   * Every supported recovery file is encrypted, so a `passphrase` is always
   * present: it calls `importEncryptedIdentity` so the new identity is protected
   * by the same passphrase the user just typed to decrypt the file, with the
   * file's hint preserved (E28c). Restoring without a passphrase is no longer
   * supported (the parser rejects legacy plaintext files) — it throws.
   *
   * `importEncryptedIdentity` writes localStorage, sets the encrypted store, and
   * primes session caches. Then commits the result to React state. Callers MUST
   * use this instead of calling the underlying functions directly.
   *
   * Async to allow the gate to await the result before unmounting itself.
   */
  acceptRestoredIdentity: (
    wif: string,
    name?: string,
    passphrase?: string,
    hint?: string
  ) => Promise<Identity>;
  // Sign-in modal
  signInOpen: boolean;
  openSignIn: () => void;
  closeSignIn: () => void;
  /**
   * Block the `pagehide → clearSessionCaches()` handler from wiping the in-memory
   * session AND any other visibility-related teardown that should pause during
   * flows where iOS may fire a system sheet (Save Password, Share, Files picker)
   * that triggers pagehide / visibilitychange on a standalone PWA — those
   * background blips would otherwise torch the active rotation mid-flow.
   *
   * Ref-counted so nested callers compose safely. Always pair every
   * `blockSessionClear()` with a corresponding `unblockSessionClear()` (use a
   * cleanup in the same effect, or unblock in the modal's close path).
   *
   * `isSessionClearBlocked()` is the reader used by other visibility handlers
   * (e.g. the You modal's `visibilitychange→manageAuthed=false` teardown in
   * IdentityBar). Sharing one ref keeps the block surface coherent across
   * every page-occlusion-driven cleanup we have.
   */
  blockSessionClear: () => void;
  unblockSessionClear: () => void;
  isSessionClearBlocked: () => boolean;
  /**
   * Gate for any transaction-requiring action. Returns true if signed in,
   * otherwise opens <SignInModal> and returns false. Use at the top of every
   * handler that needs a signed BSV identity (post, boot, tip, future):
   *
   *   const { identity, requireIdentity } = useIdentityContext();
   *   if (!requireIdentity() || !identity) return;
   *   // identity is non-null here — proceed with sign / spend
   *
   * Do NOT call signPost, clientSideBoot, or any other wif-using service
   * from a UI handler without this gate. See CLAUDE.md "Universal pattern".
   */
  requireIdentity: () => boolean;
  /**
   * True when running inside an in-app WebView (Telegram via
   * `window.TelegramWebviewProxy`; Instagram/X/Facebook/TikTok/… via UA) and
   * NOT an installed standalone PWA. Read SYNCHRONOUSLY on first client render
   * so the read-only gate is in place before any interaction. When true the
   * feed is READ-ONLY: every write action (post/boost/deposit/You-modal) routes
   * to <InAppPromptModal> ("open in your browser") instead of proceeding.
   *
   * The `!detectStandalone()` term is load-bearing: installed iOS PWAs drop
   * `Safari/` from their UA (identical to a bare WebView), so without it every
   * installed-PWA user would be wrongly locked read-only. See DECISIONS.md
   * "In-app browsers ... read-only live feed".
   */
  isReadOnly: boolean;
  /** The in-app "open in your browser" prompt shown on a read-only write attempt. */
  inAppPromptOpen: boolean;
  openInAppPrompt: () => void;
  closeInAppPrompt: () => void;
  /** Misdetect escape — a wrongly-flagged real browser dismisses read-only for the session. */
  dismissReadOnly: () => void;
  /** Cross-component signal to open the save-recovery flow (ProtectModal). The
   *  nonce changes on each call; IdentityBar watches it. For surfaces that don't
   *  own the modal (e.g. the Feed-site deposit value-gate's "Save my account"). */
  saveRecoveryNonce: number;
  requestSaveRecovery: () => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const identityValue = useIdentity();
  const [signInOpen, setSignInOpen] = useState(false);

  const openSignIn = useCallback(() => setSignInOpen(true), []);
  const closeSignIn = useCallback(() => setSignInOpen(false), []);

  // Read-only mode: in-app WebView (NOT an installed PWA). Read once,
  // synchronously, on the first client render (lazy initializer) so the gate is
  // already in place before any tap — an in-app session has a freshly-minted
  // (harmless) identity that would otherwise pass requireIdentity(). The value
  // never changes within a session (a WebView doesn't become Safari mid-visit).
  const [isReadOnly, setIsReadOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false; // SSR → false; first client commit sets it
    try {
      // Misdetect escape: a wrongly-flagged real browser tapped "continue anyway".
      if (sessionStorage.getItem("openbook_inapp_continue") === "1") return false;
    } catch {
      /* sessionStorage unavailable — fall through to detection */
    }
    return isInAppBrowserClient() && !detectStandalone();
  });
  const [inAppPromptOpen, setInAppPromptOpen] = useState(false);
  const openInAppPrompt = useCallback(() => setInAppPromptOpen(true), []);
  const closeInAppPrompt = useCallback(() => setInAppPromptOpen(false), []);
  // Cross-component "open the save-recovery flow" signal — lets surfaces that
  // DON'T own the ProtectModal (e.g. the Feed-site deposit value-gate) trigger
  // it. IdentityBar watches the nonce and opens ProtectModal on each change.
  const [saveRecoveryNonce, setSaveRecoveryNonce] = useState(0);
  const requestSaveRecovery = useCallback(() => setSaveRecoveryNonce((n) => n + 1), []);
  // Misdetect escape hatch — a wrongly-flagged real browser disables read-only
  // for the rest of the session (persisted so a reload stays dismissed).
  const dismissReadOnly = useCallback(() => {
    try {
      sessionStorage.setItem("openbook_inapp_continue", "1");
    } catch {
      /* non-fatal */
    }
    setIsReadOnly(false);
    setInAppPromptOpen(false);
  }, []);

  // Ref-counted suppression of pagehide-driven session clearing. Ref (not
  // state) so the pagehide handler reads the live value without re-binding
  // the listener on every change, and so blockers don't trigger renders.
  const sessionClearBlockedRef = useRef(0);
  const blockSessionClear = useCallback(() => {
    sessionClearBlockedRef.current += 1;
  }, []);
  const unblockSessionClear = useCallback(() => {
    sessionClearBlockedRef.current = Math.max(0, sessionClearBlockedRef.current - 1);
  }, []);
  const isSessionClearBlocked = useCallback(() => sessionClearBlockedRef.current > 0, []);

  const requireIdentity = useCallback((): boolean => {
    // Read-only FIRST: an in-app user has a (harmless) minted identity, so the
    // identity check below would otherwise pass and let the write proceed.
    if (isReadOnly) {
      setInAppPromptOpen(true);
      return false;
    }
    if (identityValue.identity) return true;
    setSignInOpen(true);
    return false;
  }, [identityValue.identity, isReadOnly]);

  const acceptRestoredIdentity = useCallback(
    async (wif: string, name?: string, passphrase?: string, hint?: string): Promise<Identity> => {
      // Every supported recovery file is encrypted, so the user always typed a
      // passphrase to decrypt it. Re-encrypt the new identity under that same
      // passphrase (importEncryptedIdentity primes _sessionIdentity AND writes
      // the encrypted store with the file's hint preserved). It is the SINGLE
      // entry point for this shape — it handles WIF validation, address
      // derivation, localStorage write, encrypted-store set, and cache priming.
      // Plaintext restore is no longer supported (the parser rejects legacy
      // plaintext files upstream); guard defensively.
      if (!passphrase) {
        throw new Error("This recovery file is no longer supported.");
      }
      const identity = await importEncryptedIdentity(wif, passphrase, name, hint);
      // updateIdentity transitions the state machine to `kind: "ready"`,
      // simultaneously clearing whatever state was previously active
      // (awaitingWelcomeGate, needsUnlock, or loading).
      identityValue.updateIdentity(identity);
      return identity;
    },
    [identityValue.updateIdentity]
  );

  // Real backgrounding → clear in-memory session caches (parity with You
  // modal password-manager pattern). Only fires in standalone mode where
  // the app can stay open in the background for long periods.
  //
  // Uses `pagehide` instead of `visibilitychange` because the latter fires
  // on transient hides on iOS PWA — including keyboard transitions — which
  // wiped the session mid-transaction. `pagehide` fires only on real page
  // unloads and app-backgrounding events.
  //
  // detectStandalone() is read INSIDE the handler (not captured in closure)
  // so iPad Stage Manager transitions between modes are caught correctly.
  useEffect(() => {
    function handleHide(): void {
      // Suppress during rotation/save-password flows — iOS fires pagehide on
      // its own system sheets (Save Password, Share, Files picker) even
      // though the user hasn't really backgrounded the app.
      if (sessionClearBlockedRef.current > 0) return;
      if (detectStandalone()) {
        clearSessionCaches();
      }
    }
    window.addEventListener("pagehide", handleHide);
    return () => window.removeEventListener("pagehide", handleHide);
  }, []);

  // Cross-tab identity sync — if another tab in the same sandbox writes an
  // identity (e.g., user completed restore in tab A while tab B was open),
  // re-read it and commit to this tab's state. Idempotent: both tabs converge
  // on the same WIF/address.
  //
  // `clearSessionCaches()` runs FIRST so `getIdentity` reflects what's actually
  // in localStorage right now, not this tab's stale in-memory cache. Without it,
  // a logout-or-rotate in tab A could leave tab B re-committing its old session
  // identity because `_sessionIdentity` short-circuits the storage read.
  useEffect(() => {
    function handleStorage(e: StorageEvent): void {
      if (e.key === "bfn_keypair" || e.key === "bfn_keypair_enc") {
        clearSessionCaches();
        getIdentity({ allowAutoGen: false })
          .then((id) => {
            if (id) identityValue.updateIdentity(id);
          })
          .catch(() => {
            /* non-fatal — local state stays as-is */
          });
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [identityValue.updateIdentity]);

  const contextValue: IdentityContextValue = {
    ...identityValue,
    acceptRestoredIdentity,
    signInOpen,
    openSignIn,
    closeSignIn,
    requireIdentity,
    isReadOnly,
    inAppPromptOpen,
    openInAppPrompt,
    closeInAppPrompt,
    dismissReadOnly,
    saveRecoveryNonce,
    requestSaveRecovery,
    blockSessionClear,
    unblockSessionClear,
    isSessionClearBlocked,
  };

  return <IdentityContext.Provider value={contextValue}>{children}</IdentityContext.Provider>;
}

export function useIdentityContext(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) {
    throw new Error("useIdentityContext must be used inside <IdentityProvider>");
  }
  return ctx;
}

/**
 * Ergonomic hook for components that need both the identity and a guard.
 * Usage:
 *   const { identity, requireIdentity } = useRequiresIdentity();
 *   function handleAction() {
 *     if (!requireIdentity()) return;   // opens modal if locked, returns false
 *     // identity is non-null here
 *   }
 */
export function useRequiresIdentity(): {
  identity: Identity | null;
  requireIdentity: () => boolean;
} {
  const ctx = useIdentityContext();
  return { identity: ctx.identity, requireIdentity: ctx.requireIdentity };
}
