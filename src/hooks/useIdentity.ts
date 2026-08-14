"use client";

import { useCallback, useEffect, useState } from "react";
import { detectStandalone } from "@/hooks/useStandaloneMode";
import {
  getIdentity,
  hasEncryptedStorePresent,
  type Identity,
  isIdentityEncrypted,
  signPost,
} from "@/services/bsv/identity";

/**
 * Internal state — a discriminated union prevents impossible states like
 * `loading + needsUnlock` or `awaitingWelcomeGate + identity != null` from
 * being representable. Boolean accessors are derived for the public return type
 * so existing consumers don't churn.
 */
type IdentityState =
  | { kind: "loading" }
  | { kind: "needsUnlock" }
  | { kind: "awaitingWelcomeGate" }
  | { kind: "ready"; identity: Identity };

interface UseIdentityReturn {
  identity: Identity | null;
  isLoading: boolean;
  needsUnlock: boolean;
  /**
   * True when the app is running in standalone (installed PWA) mode AND no
   * identity exists in localStorage. The parent (`IdentityProvider`) renders
   * `<HomeScreenWelcomeGate>` to force a restore-or-instruct decision instead
   * of silently auto-generating a new identity in the sandbox.
   *
   * Always false in browser-tab mode (auto-gen runs there as before).
   */
  awaitingWelcomeGate: boolean;
  sign: (content: string) => Promise<{ signature: string; pubkey: string } | null>;
  updateIdentity: (newIdentity: Identity) => void;
}

export function useIdentity(): UseIdentityReturn {
  const [state, setState] = useState<IdentityState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    // Read standalone state ONCE at the top of the effect. Reading it again
    // after an `await` would be a TOCTOU bug if the user transitions modes
    // (iPad Stage Manager) mid-load.
    const standalone = detectStandalone();
    // In standalone mode + no identity, do NOT auto-generate — the welcome gate
    // handles the restore/no-file branches instead. Browser-tab mode keeps the
    // existing auto-gen behavior for first-time visitors.
    const allowAutoGen = !standalone;

    async function load(): Promise<void> {
      try {
        // Always honor the encrypted-store check first. A user with an encrypted
        // identity needs to unlock via passphrase regardless of standalone mode —
        // the existing `isIdentityEncrypted()` already accounts for the
        // interrupted-upgrade case (plaintext + encrypted both present → returns
        // plaintext via getIdentity, never fires welcome gate). A genuinely
        // corrupted encrypted store returns false from isIdentityEncrypted(),
        // falls through to the standalone branch, and the user sees the welcome
        // gate (recoverable) instead of being stuck on a passphrase prompt
        // (unrecoverable).
        const id = await getIdentity({ allowAutoGen });
        if (cancelled) return;

        if (id !== null) {
          setState({ kind: "ready", identity: id });
          return;
        }

        // id === null. Three reasons:
        // 1. Encrypted store exists → user must unlock
        // 2. Standalone + no identity → welcome gate must fire
        // 3. Browser tab + auto-gen failed (rare — disk full, private browsing quota)
        // Use the presence-aware check: a corrupt/unparseable encrypted store
        // makes isIdentityEncrypted() return false, but it's still a protected
        // store and must route to unlock (not the browser-tab retry → hang).
        // (Finding 3, deep audit 2026-06-15.)
        let encrypted = false;
        try {
          encrypted = isIdentityEncrypted() || hasEncryptedStorePresent();
        } catch {
          // localStorage threw (private browsing quota, etc.) — treat as no encrypted store
          encrypted = false;
        }

        if (encrypted) {
          setState({ kind: "needsUnlock" });
        } else if (standalone) {
          setState({ kind: "awaitingWelcomeGate" });
        } else {
          // Browser tab with no identity AND no encrypted store — this is the
          // edge case where auto-gen failed. Surface as "loading complete with
          // no identity" so UI doesn't hang. The user can refresh or any action
          // requiring identity will surface the failure.
          setState({ kind: "loading" });
          // Best-effort retry once (no infinite loop — single attempt).
          const retry = await getIdentity({ allowAutoGen: true });
          if (!cancelled) {
            setState(retry ? { kind: "ready", identity: retry } : { kind: "loading" });
          }
        }
      } catch (err) {
        console.error("OpenBook: failed to load identity (BSV SDK may not have loaded)", err);
        if (!cancelled) setState({ kind: "loading" });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sign = useCallback(async (content: string) => {
    return signPost(content);
  }, []);

  const updateIdentity = useCallback((newIdentity: Identity) => {
    // Transitions any of {loading, needsUnlock, awaitingWelcomeGate} → ready.
    // Single entry point for context to commit a restored, unlocked, or
    // freshly-generated identity into the hook's state machine.
    setState({ kind: "ready", identity: newIdentity });
  }, []);

  // Boolean accessors derived from the discriminated union state. Existing
  // consumers (Feed.tsx, IdentityBar, etc.) read these flags unchanged.
  const identity = state.kind === "ready" ? state.identity : null;
  return {
    identity,
    isLoading: state.kind === "loading",
    needsUnlock: state.kind === "needsUnlock",
    awaitingWelcomeGate: state.kind === "awaitingWelcomeGate",
    sign,
    updateIdentity,
  };
}
