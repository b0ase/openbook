"use client";

import { useEffect, useRef, useState } from "react";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useInstallContext } from "@/contexts/InstallContext";
import {
  type BackupData,
  downloadBackup,
  getStoredHint,
  shareOrDownloadBackup,
} from "@/services/bsv/backup-template";
import { changePassphrase, unlockIdentity } from "@/services/bsv/identity";
import type { Identity } from "@/types";

interface ChangePassphraseModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fires when the passphrase change itself succeeds (storage updated). Address unchanged. */
  onSuccess: () => void;
  /**
   * Fires ONLY after the user explicitly saves the recovery file — never on
   * success alone. Parent uses it to flip markBackedUp() (DECISIONS.md
   * "Per-address saved flag" + "No auto-download on rotation; explicit Save").
   */
  onSaved: () => void;
  currentIdentity: Identity;
  /**
   * Passphrase that was already verified at the parent gate (manage modal entry).
   * When provided, the verify step is skipped — user goes straight to newpass entry.
   */
  preVerifiedPassphrase?: string;
}

export function ChangePassphraseModal({
  isOpen,
  onClose,
  onSuccess,
  onSaved,
  currentIdentity,
  preVerifiedPassphrase,
}: ChangePassphraseModalProps): React.JSX.Element | null {
  const [step, setStep] = useState<"verify" | "newpass" | "done">(
    preVerifiedPassphrase ? "newpass" : "verify"
  );
  // Store BackupData from a successful change so "Download" can re-fire it.
  const [doneBackup, setDoneBackup] = useState<BackupData | null>(null);
  const [currentPass, setCurrentPass] = useState(preVerifiedPassphrase ?? "");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [saved, setSaved] = useState(false);
  // Scroll the (mounted) submit button above the keyboard when the lowest input
  // is focused — its own scrollIntoView only centered the field, leaving the
  // button behind the keyboard. Delayed so it fires after the keyboard opens +
  // the viewport resizes. One shared ref is safe: only one step renders at a
  // time, so only one <button ref={submitRef}> is mounted. (QA 2026-06-25, matches ProtectModal)
  const submitRef = useRef<HTMLButtonElement>(null);
  const scrollSubmitIntoView = () => {
    setTimeout(() => {
      submitRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 300);
  };

  // Suppress pagehide-driven session wipe from the moment the change starts
  // until the user dismisses "done". iOS Save-Password sheet on PWA fires
  // pagehide; without this the encrypted store updates but the in-memory
  // session is torched and the modal renders into a re-locked state.
  const { blockSessionClear, unblockSessionClear } = useIdentityContext();
  const blockedRef = useRef(false);
  const block = () => {
    if (!blockedRef.current) {
      blockedRef.current = true;
      blockSessionClear();
    }
  };
  const unblock = () => {
    if (blockedRef.current) {
      blockedRef.current = false;
      unblockSessionClear();
    }
  };
  // Safety net: if the modal unmounts mid-flow without handleClose firing,
  // make sure we release our block.
  useEffect(() => {
    return () => {
      if (blockedRef.current) {
        blockedRef.current = false;
        unblockSessionClear();
      }
    };
  }, [unblockSessionClear]);

  // E32: block the install pitch while this modal is mounted (prevents the
  // pitch from sliding up over the done state when the user saves their new
  // recovery file). Released on unmount → install pitch fires at a clean moment.
  const { blockInstallPitch, unblockInstallPitch, refreshProtected } = useInstallContext();
  useEffect(() => {
    blockInstallPitch();
    return () => unblockInstallPitch();
  }, [blockInstallPitch, unblockInstallPitch]);

  function handleClose() {
    unblock();
    setStep(preVerifiedPassphrase ? "newpass" : "verify");
    setCurrentPass(preVerifiedPassphrase ?? "");
    setNewPass("");
    setConfirmPass("");
    setHint("");
    setError("");
    setDoneBackup(null);
    setSharing(false);
    setSaved(false);
    onClose();
  }

  async function handleVerify() {
    setWorking(true);
    setError("");
    try {
      const unlocked = await unlockIdentity(currentPass);
      if (!unlocked) {
        setError("Wrong passphrase");
        setWorking(false);
        return;
      }
      setStep("newpass");
    } catch {
      setError("Something went wrong");
    } finally {
      setWorking(false);
    }
  }

  async function handleChange() {
    const resolvedOldPass = preVerifiedPassphrase ?? currentPass;
    if (newPass.length < 8) {
      setError("Passphrase must be at least 8 characters");
      return;
    }
    if (newPass !== confirmPass) {
      setError("Passphrases don't match");
      return;
    }
    if (newPass === resolvedOldPass) {
      setError("New passphrase must be different");
      return;
    }
    if (!hint.trim()) {
      setError("Add a memory clue — it's your only reminder if you forget.");
      return;
    }

    setWorking(true);
    setError("");
    // Hold the session lock from here through the "done"/save step — iOS may
    // fire pagehide on its Save-Password sheet. Released in handleClose / on error.
    block();
    try {
      // Re-encrypt the SAME key under the new passphrase in place. No new key,
      // no migration, no sweep — the address never changes.
      const result = await changePassphrase(resolvedOldPass, newPass, hint.trim());

      if (!result.ok) {
        // The old passphrase no longer matches (e.g. a stale pre-verified value
        // after the key was changed in another tab). Send the user back to verify.
        setError("Wrong passphrase — please try again");
        setStep("verify");
        setCurrentPass("");
        unblock();
        return;
      }

      // Address/key unchanged; only the protection-state gate needs refreshing.
      refreshProtected();

      // Read the freshly-written encrypted store to build the recovery file —
      // no re-encrypt, and NEVER a plaintext fallback (no unencrypted key ever
      // leaves the device).
      let encryptedWif: string | undefined;
      try {
        const raw = localStorage.getItem("bfn_keypair_enc");
        if (raw) encryptedWif = (JSON.parse(raw) as { encrypted?: string }).encrypted;
      } catch {
        // fall through to the guard below
      }
      if (!encryptedWif) {
        throw new Error("Couldn't prepare your recovery file — try saving from the You menu.");
      }

      const backupPayload: BackupData = {
        name: currentIdentity.name,
        address: currentIdentity.address,
        wif_encrypted: encryptedWif,
        pathType: "save",
        createdAt: new Date().toISOString(),
        note: "Use your new passphrase to restore.",
        hint: hint.trim(),
      };
      setDoneBackup(backupPayload);
      setStep("done");
      // Notify the parent AFTER committing the local done-state, so a parent
      // re-render can't unmount this modal before "done" renders (DECISIONS.md
      // "Local state commits BEFORE parent notification").
      onSuccess();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(msg || "Something went wrong — try again");
      console.error("OpenBook: passphrase change failed", e);
      unblock();
    } finally {
      setWorking(false);
    }
  }

  // Explicit save — Web Share on iOS, <a download> fallback elsewhere. block()
  // is already held from handleChange; idempotent. Fires onSaved ONLY on a real
  // save (not on cancel).
  async function handleSaveBackup(): Promise<void> {
    if (!doneBackup || sharing) return;
    setSharing(true);
    block();
    try {
      const result = await shareOrDownloadBackup(doneBackup);
      if (result.cancelled) return; // user dismissed the share drawer — keep done state
      if (result.shared) {
        setSaved(true);
        onSaved();
      }
    } finally {
      setSharing(false);
    }
  }

  if (!isOpen) return null;

  const storedHint = getStoredHint();
  const canSubmitNew =
    newPass.length >= 8 && newPass === confirmPass && Boolean(hint.trim()) && !working;

  return (
    <>
      {/* Non-dismissing backdrop — high-stakes flow; outside taps must NOT discard
          the entry. Exit via the X or Cancel. (QA 2026-06-23) */}
      <div className="fixed inset-0 z-[70] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]" />

      {/* Modal — pinned to top of viewport (iOS-native pattern). Does
          NOT track the keyboard; sits above where it slides up. */}
      <div className="fixed inset-0 z-[70] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border border-amber-400/20 shadow-2xl overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] flex flex-col overflow-y-auto"
          style={{ backgroundColor: "#0f0f0f" }}
        >
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
            <div>
              <p className="text-sm font-semibold text-zinc-100">Change passphrase</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {step === "verify"
                  ? "Verify your current passphrase first"
                  : step === "done"
                    ? "Save your updated recovery file"
                    : "A new recovery file will be ready to save"}
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
            {step === "done" ? (
              saved ? (
                <>
                  <div className="border-l-2 border-emerald-500/60 pl-2.5 py-0.5">
                    <p className="text-[11px] text-emerald-400/90 leading-relaxed">
                      Recovery file saved. Keep it somewhere safe &mdash; it&apos;s your only way
                      back into your account.
                    </p>
                  </div>
                  <div className="flex gap-2 pt-3">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex-1 bg-amber-500/10 text-amber-400 border border-amber-500/40 rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                    >
                      Got it
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="border-l-2 border-amber-500/60 pl-2.5 py-0.5">
                    <p className="text-[11px] text-amber-400/90 leading-relaxed">
                      Passphrase changed. Save your new recovery file now. Your old file still works
                      with your old passphrase &mdash; delete old copies if that passphrase was ever
                      exposed.
                    </p>
                  </div>
                  <div className="flex gap-2 pt-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (doneBackup) downloadBackup(doneBackup);
                      }}
                      className="flex-1 bg-zinc-900 text-zinc-300 border border-amber-400/20 rounded-lg px-3 py-2 text-xs font-medium hover:bg-zinc-800 transition-colors"
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveBackup()}
                      disabled={sharing}
                      className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {sharing ? "Saving..." : "Save recovery file"}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="w-full text-center text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors pt-1"
                  >
                    I&apos;ll do it later
                  </button>
                </>
              )
            ) : step === "verify" ? (
              <>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current passphrase"
                  value={currentPass}
                  onChange={(e) => {
                    setCurrentPass(e.target.value);
                    setError("");
                  }}
                  onFocus={scrollSubmitIntoView}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && currentPass) void handleVerify();
                  }}
                  className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                />
                {storedHint && (
                  <div className="border-l-2 border-amber-500/60 pl-2 py-0.5">
                    <span className="text-[11px] text-amber-400/90">Hint: {storedHint}</span>
                  </div>
                )}
                {error && <p className="text-[11px] text-red-400">{error}</p>}
                <div className="flex gap-2 pt-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-2 text-xs font-medium hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    ref={submitRef}
                    type="button"
                    onClick={() => void handleVerify()}
                    disabled={!currentPass || working}
                    className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {working ? "Checking..." : "Continue"}
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmitNew) void handleChange();
                }}
                className="space-y-3"
              >
                {/* iCloud Keychain anchor — hidden username so Keychain matches
                    this form to the existing credential and fires "Update
                    Password?" (DECISIONS.md "iCloud Keychain requires a username
                    anchor"). identity.name is stable, so iOS sees an update. */}
                <input
                  type="text"
                  autoComplete="username"
                  value={currentIdentity.name}
                  readOnly
                  hidden
                />
                <p className="text-[11px] text-amber-400/80 leading-relaxed">
                  You&apos;ll save a new recovery file that uses your new passphrase. Your old file
                  still opens with your old passphrase.
                </p>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New passphrase (min 8 characters)"
                  value={newPass}
                  onChange={(e) => {
                    setNewPass(e.target.value);
                    setError("");
                  }}
                  onFocus={(e) => e.currentTarget.scrollIntoView({ block: "center" })}
                  className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new passphrase"
                  value={confirmPass}
                  onChange={(e) => {
                    setConfirmPass(e.target.value);
                    setError("");
                  }}
                  onFocus={(e) => e.currentTarget.scrollIntoView({ block: "center" })}
                  className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                />

                {/* Memory clue — always visible, amber accent, mandatory */}
                <div className="border-l-2 border-amber-500/60 pl-2.5 space-y-1">
                  <label
                    htmlFor="change-hint"
                    className="text-[11px] text-amber-400/80 font-medium block"
                  >
                    Memory clue
                  </label>
                  <input
                    id="change-hint"
                    type="text"
                    placeholder={`e.g. "blue house + 2019"`}
                    value={hint}
                    maxLength={100}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) => setHint(e.target.value)}
                    onFocus={scrollSubmitIntoView}
                    className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                  />
                  <p className={`text-[10px] ${hint.trim() ? "text-red-400" : "text-zinc-600"}`}>
                    Only you should know what this means &mdash; it&apos;s stored unprotected in
                    your recovery file.
                  </p>
                </div>

                {error && <p className="text-[11px] text-red-400">{error}</p>}

                <div className="flex gap-2 pt-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-2 text-xs font-medium hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    ref={submitRef}
                    type="submit"
                    disabled={!canSubmitNew}
                    className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {working ? "Changing..." : "Change passphrase"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
