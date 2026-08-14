"use client";

import { useEffect, useRef, useState } from "react";
import { PassphrasePrompt } from "@/components/PassphrasePrompt";
import { useInstallContext } from "@/contexts/InstallContext";
import { decryptWif } from "@/services/bsv/crypto";
import { parseRecoveryFile } from "@/services/bsv/restore-from-file";
import type { Identity } from "@/types";

interface HomeScreenWelcomeGateProps {
  /**
   * SINGLE entry point for restore — `IdentityContext.acceptRestoredIdentity`
   * re-encrypts the restored key under the passphrase the user typed to decrypt
   * the file (with the file's hint preserved), so the restored identity lands
   * protected. The gate never calls the underlying identity functions directly.
   * (E28c — earlier the gate dropped the typed passphrase, landing every
   * encrypted-file restore as plaintext.)
   */
  onRestore: (wif: string, name?: string, passphrase?: string, hint?: string) => Promise<Identity>;
}

type Mode = "buttons" | "passphrase" | "no-file";

/**
 * Full-screen takeover fired by `IdentityProvider` when standalone mode + no
 * identity (per LAUNCH_PLAN.md sequencing revision 2026-05-11). Not dismissable —
 * it's a routing decision, not a dialog.
 *
 * **Restore-only by design.** There is no "Start with a new identity" path in
 * standalone mode. Auto-gen NEVER fires in a PWA sandbox — that would silently
 * spawn a new identity per home-screen icon (the exact bug we're solving). Users
 * without a recovery file are routed to Safari to set up first, then come back.
 *
 * Two visible paths:
 * 1. **Restore from saved file** → file picker → optional passphrase → import
 * 2. **I don't have a recovery file** → instructional screen explaining the path
 *    (set up in Safari, save a file, return). Pure-render — NO localStorage
 *    writes. A stray setItem here would reintroduce the silent-multi-identity
 *    bug we're fixing.
 */
export function HomeScreenWelcomeGate({
  onRestore,
}: HomeScreenWelcomeGateProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("buttons");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [encryptedPayload, setEncryptedPayload] = useState<{
    wif_encrypted: string;
    name?: string;
    hint?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);

  // The file the user just restored from IS their backup by definition. Mark
  // backed up so the You modal doesn't bounce them into a redundant "Save your
  // recovery file" prompt (parity with RestoreModal.onSuccess).
  const { markBackedUp } = useInstallContext();

  // Auto-focus the primary action on mount. No focus trap needed — the gate IS
  // the full screen, there's nothing to escape to.
  useEffect(() => {
    restoreButtonRef.current?.focus();
  }, []);

  function handleRestoreClick(): void {
    setError("");
    fileInputRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    // Clear so re-picking the same file fires onChange again.
    e.target.value = "";
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const result = await parseRecoveryFile(file);
      if (!result.ok) {
        setError(
          result.error === "unsupported_version"
            ? "This recovery file is from an older version and can't be restored. Use a file you saved recently."
            : result.error === "parse_failed"
              ? "Could not read this file — make sure it's an OpenBooks recovery file (.html or .json)"
              : "File does not contain a valid recovery key"
        );
        return;
      }
      if (result.payload.kind === "encrypted") {
        setEncryptedPayload({
          wif_encrypted: result.payload.wif_encrypted,
          name: result.payload.name,
          hint: result.payload.hint,
        });
        setMode("passphrase");
        return;
      }
      // kind === "plain" is unreachable — the parser rejects plaintext files as
      // unsupported_version — but TS still narrows it, so handle defensively.
      setError("This recovery file is from an older version and can't be restored.");
    } catch {
      setError("Something went wrong — please try again");
    } finally {
      setBusy(false);
    }
  }

  async function handlePassphrase(passphrase: string): Promise<void> {
    if (!encryptedPayload || busy) return;
    setBusy(true);
    setError("");
    try {
      const wif = await decryptWif(encryptedPayload.wif_encrypted, passphrase);
      if (!wif) {
        setError("Wrong passphrase — try again");
        return;
      }
      // E28c: forward the passphrase + hint so the new identity is protected
      // by the same passphrase the user just typed (with the file's hint
      // preserved). Without this the restored identity lands as plaintext.
      await onRestore(wif, encryptedPayload.name, passphrase, encryptedPayload.hint);
      markBackedUp();
    } catch {
      setError("Something went wrong — please try again");
    } finally {
      setBusy(false);
    }
  }

  function handlePassphraseCancel(): void {
    setEncryptedPayload(null);
    setError("");
    setMode("buttons");
  }

  function handleNoFileClick(): void {
    setError("");
    setMode("no-file");
  }

  function handleBackToButtons(): void {
    setError("");
    setMode("buttons");
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col items-center justify-start bg-[#0f0f0f] px-6 pt-[15vh] pb-12"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-gate-headline"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".html,.json,text/html,application/json"
        onChange={handleFile}
        className="hidden"
      />

      <div className="w-full max-w-sm space-y-6">
        {/* Brand lockup — ALWAYS rendered first, same size/colour/position in every
            mode (buttons / passphrase / no-file). Top-anchored container (justify-start
            + pt) so it never shifts when the screen below it changes. */}
        <h1
          id="welcome-gate-headline"
          className="text-center font-bold tracking-tight text-white text-[clamp(2.5rem,16vw,4.5rem)] leading-none"
        >
          <span className="text-amber-400">$Open</span>Books
        </h1>
        {mode === "no-file" ? (
          <>
            <div className="text-center space-y-2">
              <h2 className="text-lg font-semibold text-zinc-100">Set up in Safari first</h2>
              <p className="text-sm text-zinc-400 leading-relaxed">
                On iPhone, Safari may clear app data after long inactivity. Your account lives in
                your recovery file — not just on this device.
              </p>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Open <span className="text-zinc-200">opencook.fun</span> in Safari, set up your
                identity, save your recovery file. Then come back to this app and restore.
              </p>
            </div>
            <button
              type="button"
              onClick={handleBackToButtons}
              className="w-full bg-transparent text-zinc-300 border border-zinc-700 rounded-xl px-4 py-3 text-sm font-medium hover:border-zinc-500 hover:text-zinc-100 transition-colors"
            >
              Back
            </button>
          </>
        ) : mode === "passphrase" ? (
          <>
            <p className="text-center text-sm text-zinc-400">
              Welcome back — enter your passphrase to unlock.
            </p>
            <PassphrasePrompt
              context="Enter the passphrase you used when creating this recovery file."
              error={error}
              loading={busy}
              onConfirm={handlePassphrase}
              onCancel={handlePassphraseCancel}
              confirmLabel="Restore"
              hint={encryptedPayload?.hint}
            />
          </>
        ) : (
          <div className="space-y-3">
            <button
              ref={restoreButtonRef}
              type="button"
              onClick={handleRestoreClick}
              disabled={busy}
              className="w-full bg-amber-400 text-black rounded-xl px-4 py-3 text-left hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-semibold">Upload your saved file to access</div>
              <div className="text-xs font-normal text-black/70 mt-0.5">
                Use your most recent recovery file. Your posts and earnings come back.
              </div>
            </button>

            <button
              type="button"
              onClick={handleNoFileClick}
              disabled={busy}
              className="w-full bg-transparent text-zinc-300 border border-zinc-700 rounded-xl px-4 py-3 text-left hover:border-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-medium">I don&apos;t have a recovery file</div>
              <div className="text-xs font-normal text-zinc-500 mt-0.5">
                Set up your identity in Safari first, then come back here.
              </div>
            </button>

            {error && <p className="text-[11px] text-red-400 text-center pt-1">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
