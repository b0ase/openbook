"use client";

import { useEffect, useRef, useState } from "react";
import { PassphrasePrompt } from "@/components/PassphrasePrompt";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useInstallContext } from "@/contexts/InstallContext";
import { satsToDollars, useBsvPrice } from "@/hooks/useBsvPrice";
import {
  type BackupData,
  getStoredHint,
  markAddressSaved,
  shareOrDownloadBackup,
} from "@/services/bsv/backup-template";
import { decryptWif, encryptWif } from "@/services/bsv/crypto";
import { importEncryptedIdentity } from "@/services/bsv/identity";
import { parseRecoveryFile } from "@/services/bsv/restore-from-file";
import type { Identity } from "@/types";

interface RestoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (identity: Identity) => void;
  /**
   * Identity currently held in localStorage on this device. Nullable for
   * contexts where the modal is opened with no outgoing identity. When null,
   * the "save outgoing key" prompt is skipped (there's no outgoing key worth
   * saving), the encrypted-key save path is unavailable, and the modal goes
   * straight from passphrase decrypt → restore.
   */
  currentIdentity: Identity | null;
  isProtected: boolean;
  reAuthPassphrase: string;
}

export function RestoreModal({
  isOpen,
  onClose,
  onSuccess,
  currentIdentity,
  isProtected,
  reAuthPassphrase,
}: RestoreModalProps): React.JSX.Element | null {
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState(false);
  const [encryptedImportData, setEncryptedImportData] = useState<{
    wif_encrypted: string;
    name?: string;
    hint?: string;
  } | null>(null);
  const [encryptedImportError, setEncryptedImportError] = useState("");
  const [decryptingImport, setDecryptingImport] = useState(false);
  const [pendingRestoreWif, setPendingRestoreWif] = useState<string | null>(null);
  const [pendingRestoreName, setPendingRestoreName] = useState<string | undefined>(undefined);
  // Capture the passphrase the user typed to decrypt the source file (and the
  // file's hint) so we can re-encrypt the new identity under the same passphrase.
  // Every supported file is encrypted, so these are always set on a real restore.
  const [pendingRestorePassphrase, setPendingRestorePassphrase] = useState<string | undefined>(
    undefined
  );
  const [pendingRestoreHint, setPendingRestoreHint] = useState<string | undefined>(undefined);
  // E27: Save-or-Skip prompt for the OUTGOING identity. Built lazily when
  // pendingRestoreWif is set so the share handler can be synchronous (iOS
  // transient activation can't survive an `await encryptWif` before share).
  const [outgoingBackupPayload, setOutgoingBackupPayload] = useState<BackupData | null>(null);
  const [outgoingEarnings, setOutgoingEarnings] = useState<number | null>(null);
  const [skipConfirmed, setSkipConfirmed] = useState(false);
  const [sharingOldKey, setSharingOldKey] = useState(false);
  const bsvPrice = useBsvPrice();

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Suppress pagehide / visibilitychange teardown during restore — iOS may
  // fire its Save Password sheet on the file picker / decrypt path on the PWA,
  // and the background blip would otherwise close this modal mid-flow.
  // Released whenever the modal dismisses (handleClose) and on unmount.
  const { blockSessionClear, unblockSessionClear } = useIdentityContext();
  const blockedRef = useRef(false);
  const block = (): void => {
    if (!blockedRef.current) {
      blockedRef.current = true;
      blockSessionClear();
    }
  };
  const unblock = (): void => {
    if (blockedRef.current) {
      blockedRef.current = false;
      unblockSessionClear();
    }
  };
  useEffect(() => {
    return () => {
      if (blockedRef.current) {
        blockedRef.current = false;
        unblockSessionClear();
      }
    };
  }, [unblockSessionClear]);

  // E32: block the install pitch while this modal is mounted. Released on
  // unmount → install pitch fires at a clean moment after the user dismisses
  // the done state. Also refreshProtected after a successful import (the
  // encrypted-file path flips protection true; plaintext path flips it false).
  const { blockInstallPitch, unblockInstallPitch, refreshProtected } = useInstallContext();
  useEffect(() => {
    blockInstallPitch();
    return () => unblockInstallPitch();
  }, [blockInstallPitch, unblockInstallPitch]);

  function handleClose() {
    unblock();
    setImportError("");
    setImporting(false);
    setImportSuccess(false);
    setEncryptedImportData(null);
    setEncryptedImportError("");
    setPendingRestoreWif(null);
    setPendingRestoreName(undefined);
    setPendingRestorePassphrase(undefined);
    setPendingRestoreHint(undefined);
    setOutgoingBackupPayload(null);
    setOutgoingEarnings(null);
    setSkipConfirmed(false);
    setSharingOldKey(false);
    onClose();
  }

  async function doImport(
    wif: string,
    name?: string,
    passphrase?: string,
    hint?: string
  ): Promise<void> {
    setImporting(true);
    setImportError("");
    // Hold the block from the moment we start touching the file system / sheets.
    // Idempotent — performImport calls block() too, just a no-op once set.
    block();

    // When there's no outgoing identity, there's nothing to "save before
    // switching" — bypass the save-or-skip prompt entirely and proceed with
    // the import. The pending state + prompt only makes sense when we're
    // replacing a key the user might want to back up first.
    if (!currentIdentity) {
      await performImport(wif, name, passphrase, hint);
      return;
    }

    // E27: NO auto-download here. The outgoing identity's recovery file is
    // built lazily by the effect below and emitted only on explicit user
    // action (Save button) inside the save-or-skip prompt that the pending
    // state triggers. Skip is gated by a confirmation toggle so the user
    // can't lose access by accident.
    setPendingRestoreWif(wif);
    setPendingRestoreName(name);
    setPendingRestorePassphrase(passphrase);
    setPendingRestoreHint(hint);
    setImporting(false);
  }

  // Build the outgoing-identity backup payload + fetch its earnings whenever
  // a pending restore is active. Pre-built so the Save handler can call
  // shareOrDownloadBackup synchronously inside the click — iOS transient
  // activation can't survive an `await encryptWif` between click and share.
  useEffect(() => {
    if (pendingRestoreWif === null) {
      setOutgoingBackupPayload(null);
      setOutgoingEarnings(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let payload: BackupData;
        if (isProtected && currentIdentity && reAuthPassphrase) {
          const encBackup = await encryptWif(currentIdentity.wif, reAuthPassphrase);
          payload = {
            name: currentIdentity.name,
            address: currentIdentity.address,
            wif_encrypted: encBackup,
            pathType: "restore-pre",
            createdAt: new Date().toISOString(),
            note: "Previous identity saved before switching.",
            hint: getStoredHint(),
          };
        } else {
          // No encrypted payload available — either the outgoing identity is
          // unprotected, or protected without the cached passphrase. We never
          // produce a plaintext file (DECISIONS.md "no unencrypted recovery file
          // ever leaves the device"), so the Save button stays disabled and the
          // user proceeds via Skip-with-confirm.
          if (!cancelled) setOutgoingBackupPayload(null);
          return;
        }
        if (!cancelled) setOutgoingBackupPayload(payload);
      } catch {
        if (!cancelled) setOutgoingBackupPayload(null);
      }
    })();
    if (currentIdentity?.address) {
      fetch(`/api/earnings?address=${encodeURIComponent(currentIdentity.address)}&summary=1`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (cancelled) return;
          setOutgoingEarnings(typeof j?.totalEarned === "number" ? j.totalEarned : 0);
        })
        .catch(() => {
          if (!cancelled) setOutgoingEarnings(0);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [pendingRestoreWif, isProtected, currentIdentity, reAuthPassphrase]);

  async function handleSaveOldKey(): Promise<void> {
    if (!outgoingBackupPayload || sharingOldKey) return;
    setSharingOldKey(true);
    block();
    try {
      const result = await shareOrDownloadBackup(outgoingBackupPayload);
      if (result.cancelled) {
        // User dismissed iOS share drawer. Stay on prompt — they can try
        // again, change their mind to Skip, or Cancel out entirely.
        return;
      }
      if (result.shared && currentIdentity) {
        markAddressSaved(currentIdentity.address);
        // Proceed with the actual import now that the outgoing key is safe.
        await confirmPendingRestore();
      }
    } finally {
      setSharingOldKey(false);
    }
  }

  function handleSkipOldKey(): void {
    if (!skipConfirmed) return;
    void confirmPendingRestore();
  }

  async function performImport(
    wif: string,
    name?: string,
    passphrase?: string,
    hint?: string
  ): Promise<void> {
    // Hold the session-clear block until the user explicitly dismisses the
    // done state. Without this iOS could fire its system sheet between
    // import and done-state mount and close the modal.
    block();
    try {
      // Every supported recovery file is encrypted (the parser rejects legacy
      // plaintext files as unsupported_version), so a passphrase is always
      // present here. The passphrase the user just typed to decrypt the file
      // becomes the passphrase guarding the new identity — we re-encrypt with
      // it + preserve the file's hint, so the user lands protected with no
      // extra step. Guard defensively in case a future caller omits it.
      if (!passphrase) throw new Error("This recovery file is no longer supported.");
      const imported = await importEncryptedIdentity(wif, passphrase, name, hint);

      // E32: refresh InstallContext's protected state after the import. The
      // restored identity is always protected, so the install pitch's
      // 5-condition gate needs to re-evaluate.
      refreshProtected();

      // The restored file IS the recovery file for this address — mark it
      // saved so the new "Unsaved key" badge doesn't fire for an address
      // the user demonstrably has a recovery file for.
      markAddressSaved(imported.address);

      // CRITICAL ordering: flip local success state BEFORE notifying the parent.
      // onSuccess(imported) triggers parent updateIdentity() → re-render.
      // If the parent re-renders while this modal is mid-transition, the
      // success state may not commit and the user lands on the home page
      // with no visible confirmation. Local state first, then parent.
      setImportSuccess(true);
      onSuccess(imported);
      // No auto-close. The user dismisses via "Got it" / X / backdrop so
      // they actually see the confirmation that restore succeeded.
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setImporting(false);
    }
  }

  async function confirmPendingRestore(): Promise<void> {
    if (!pendingRestoreWif) return;
    const wif = pendingRestoreWif;
    const name = pendingRestoreName;
    const passphrase = pendingRestorePassphrase;
    const hint = pendingRestoreHint;
    setPendingRestoreWif(null);
    setPendingRestoreName(undefined);
    setPendingRestorePassphrase(undefined);
    setPendingRestoreHint(undefined);
    setImporting(true);
    await performImport(wif, name, passphrase, hint);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");

    const result = await parseRecoveryFile(file);
    if (!result.ok) {
      setImportError(
        result.error === "unsupported_version"
          ? "This recovery file is from an older version and can't be restored. Use a file you saved recently."
          : result.error === "no_key"
            ? "File does not contain a valid recovery key"
            : "Could not read file — make sure it is an OpenBook recovery file (.html or .json)"
      );
      return;
    }

    if (result.payload.kind === "encrypted") {
      setEncryptedImportData({
        wif_encrypted: result.payload.wif_encrypted,
        name: result.payload.name,
        hint: result.payload.hint,
      });
      setEncryptedImportError("");
      return;
    }

    // kind === "plain" is unreachable — the parser rejects plaintext files as
    // unsupported_version — but TS still narrows it, so handle defensively.
    setImportError("This recovery file is from an older version and can't be restored.");
  }

  async function handleDecryptAndImport(passphrase: string): Promise<void> {
    if (!encryptedImportData) return;
    setDecryptingImport(true);
    setEncryptedImportError("");
    try {
      const wif = await decryptWif(encryptedImportData.wif_encrypted, passphrase);
      if (!wif) {
        setEncryptedImportError("Wrong passphrase — try again");
        setDecryptingImport(false);
        return;
      }
      const name = encryptedImportData.name;
      const hint = encryptedImportData.hint;
      setEncryptedImportData(null);
      // Pass passphrase + hint through so the new identity is re-encrypted with
      // the same passphrase the user just typed. Preserves the file's hint too.
      // performImport branches on `passphrase` to call importEncryptedIdentity.
      await doImport(wif, name, passphrase, hint);
    } catch {
      setEncryptedImportError("Something went wrong — try again");
    } finally {
      setDecryptingImport(false);
    }
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Non-dismissing backdrop — high-stakes flow; outside taps must NOT discard
          the entry. Exit via the X or Cancel. (QA 2026-06-23) */}
      <div className="fixed inset-0 z-[100] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]" />

      {/* Modal — pinned to top of viewport (iOS-native pattern). */}
      {/* z-[100]: above SignInModal (z-[80]) so the restore flow always sits */}
      {/* on top when chained from the sign-in modal. */}
      <div className="fixed inset-0 z-[100] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border border-amber-400/20 shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] overflow-y-auto"
          style={{ backgroundColor: "#0f0f0f" }}
        >
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
            <div>
              <p className="text-sm font-semibold text-zinc-100">Upload your saved file</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                This will replace your current identity
              </p>
            </div>
            <button
              type="button"
              onClick={handleClose}
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

          {/* Body */}
          <div className="px-5 py-5 space-y-3">
            {importSuccess ? (
              <>
                <div className="border-l-2 border-amber-500/60 pl-2.5 py-0.5">
                  <p className="text-[11px] text-amber-400/90 leading-relaxed">
                    Your identity has been restored. Your posts and earnings are now linked to this
                    key on this device. Tap Got it when you&apos;re ready.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  className="w-full bg-amber-500/10 text-amber-400 border border-amber-500/40 rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                >
                  Got it
                </button>
              </>
            ) : (
              <>
                <p className="text-[11px] text-red-400 leading-relaxed">
                  Your current recovery file will be saved first.
                </p>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Your current posts and earnings stay with your current key — the backup file is
                  how you return to them.
                </p>

                {pendingRestoreWif !== null ? (
                  <div className="space-y-3 bg-amber-400/5 rounded-lg p-3 border border-amber-400/15">
                    <p className="text-[11px] text-zinc-200 leading-relaxed font-medium">
                      You&apos;re about to switch to a different key.
                    </p>
                    {outgoingEarnings !== null && outgoingEarnings > 0 ? (
                      <p className="text-[11px] text-amber-400/90 leading-relaxed">
                        Your current key (
                        <span className="font-semibold text-amber-300">
                          {currentIdentity?.name ?? "this key"}
                        </span>
                        ) has{" "}
                        <span className="font-semibold text-amber-300">
                          {outgoingEarnings.toLocaleString()} sats
                        </span>
                        {bsvPrice > 0 ? (
                          // Same dynamic-decimal formatter as the chip/identity card
                          // (not a hard 2-decimal cap, which showed sub-cent as $0.00).
                          <> (~{satsToDollars(outgoingEarnings, bsvPrice)})</>
                        ) : null}{" "}
                        on this device.
                      </p>
                    ) : (
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        {outgoingBackupPayload
                          ? "Save the current key's recovery file first if you might want to come back to it."
                          : "Your current key isn't protected — add a passphrase to keep it, or skip to continue."}
                      </p>
                    )}
                    {!skipConfirmed ? (
                      <>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          {outgoingBackupPayload
                            ? "Save its recovery file so you can come back to it later, or skip if you already have a backup elsewhere."
                            : "An unprotected key can't be saved to a file here. Skip to continue — or cancel and add a passphrase first if you want to keep it."}
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setSkipConfirmed(true)}
                            disabled={sharingOldKey || importing}
                            className="flex-1 bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Skip
                          </button>
                          {outgoingBackupPayload && (
                            <button
                              type="button"
                              onClick={handleSaveOldKey}
                              disabled={sharingOldKey || importing}
                              className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {sharingOldKey ? "Saving..." : "Save current key"}
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-[11px] text-red-400 leading-relaxed font-medium">
                          Your current key will be lost forever unless you&apos;ve saved its
                          recovery file elsewhere.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setSkipConfirmed(false)}
                            disabled={importing}
                            className="flex-1 bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Go back
                          </button>
                          <button
                            type="button"
                            onClick={handleSkipOldKey}
                            disabled={importing}
                            className="flex-1 bg-red-500/20 text-red-300 border border-red-500/40 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-red-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {importing ? "Restoring..." : "Skip & restore anyway"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : encryptedImportData !== null ? (
                  <PassphrasePrompt
                    context="This recovery file is encrypted. Enter the passphrase you used when creating it."
                    error={encryptedImportError}
                    loading={decryptingImport}
                    onConfirm={handleDecryptAndImport}
                    onCancel={() => {
                      setEncryptedImportData(null);
                      setEncryptedImportError("");
                    }}
                    confirmLabel="Restore"
                    hint={encryptedImportData.hint}
                  />
                ) : (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".html,.json,text/html,application/json"
                      onChange={handleImportFile}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importing}
                      className="w-full bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-400/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {importing ? "Restoring..." : "Choose recovery file"}
                    </button>
                  </>
                )}

                {importError && (
                  <p className="text-[11px] text-red-400 leading-relaxed">{importError}</p>
                )}

                <button
                  type="button"
                  onClick={handleClose}
                  className="w-full bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-2 text-xs font-medium hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
