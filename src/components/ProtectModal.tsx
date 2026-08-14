"use client";

import { useEffect, useRef, useState } from "react";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useInstallContext } from "@/contexts/InstallContext";
import { type BackupData, shareOrDownloadBackup } from "@/services/bsv/backup-template";
import { encryptInPlace } from "@/services/bsv/identity";
import type { Identity } from "@/types";

interface ProtectModalProps {
  identity: Identity;
  /** Fires when encryptInPlace commits (the identity is now protected). Address unchanged. */
  onComplete: () => void;
  /**
   * Fires ONLY after the user explicitly saves the recovery file — never on
   * success alone. Parent uses it to flip markBackedUp().
   */
  onSaved: () => void;
  onClose: () => void;
}

/**
 * Adds a passphrase to an UNPROTECTED identity by encrypting the EXISTING key
 * in place (same key, same address — no new key, no migration, no sweep).
 * Replaces the rotation-based "protect" path. (DECISIONS.md "Key rotation
 * REMOVED in favor of encrypt-in-place".)
 */
export function ProtectModal({
  identity,
  onComplete,
  onSaved,
  onClose,
}: ProtectModalProps): React.JSX.Element {
  const [step, setStep] = useState<"passphrase" | "done">("passphrase");
  const [doneBackup, setDoneBackup] = useState<BackupData | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [saved, setSaved] = useState(false);
  // Scroll target: focusing the memory-clue field (the last input) should bring
  // the SUBMIT BUTTON — the lowest element — above the keyboard, not just the
  // field (which is what its own scrollIntoView did, leaving the button behind
  // the keyboard). Delayed so it fires AFTER the keyboard has opened + the
  // viewport has resized. (QA 2026-06-25)
  const submitRef = useRef<HTMLButtonElement>(null);
  const scrollSubmitIntoView = () => {
    setTimeout(() => {
      submitRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 300);
  };

  // Suppress pagehide-driven session wipe from the moment protection starts
  // until the user dismisses "done". iOS Save-Password sheet on PWA fires
  // pagehide; without this the encrypted store is written but the in-memory
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
  // Safety net: release the block if the modal unmounts mid-flow.
  useEffect(() => {
    return () => {
      if (blockedRef.current) {
        blockedRef.current = false;
        unblockSessionClear();
      }
    };
  }, [unblockSessionClear]);

  // Block the install pitch while mounted — prevents it sliding up over the
  // done state when the user saves their recovery file. (After encryptInPlace,
  // refreshProtected flips `protected` true, one of the pitch's gate conditions.)
  const { blockInstallPitch, unblockInstallPitch, refreshProtected } = useInstallContext();
  useEffect(() => {
    blockInstallPitch();
    return () => unblockInstallPitch();
  }, [blockInstallPitch, unblockInstallPitch]);

  function handleClose() {
    unblock();
    setStep("passphrase");
    setPass("");
    setConfirm("");
    setHint("");
    setError("");
    setDoneBackup(null);
    setSharing(false);
    setSaved(false);
    onClose();
  }

  async function handleProtect() {
    if (pass.length < 8) {
      setError("Passphrase must be at least 8 characters");
      return;
    }
    if (pass !== confirm) {
      setError("Passphrases don't match");
      return;
    }
    if (!hint.trim()) {
      setError("Add a memory clue — it's your only reminder if you forget.");
      return;
    }

    setWorking(true);
    setError("");
    // Hold the session lock from here through the "done"/save step.
    block();
    try {
      // Encrypt the EXISTING key in place — same key, same address.
      await encryptInPlace(pass, hint.trim());
      refreshProtected();

      // Build the recovery file from the freshly-written encrypted store —
      // NEVER a plaintext fallback (no unencrypted key ever leaves the device).
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
        name: identity.name,
        address: identity.address,
        wif_encrypted: encryptedWif,
        pathType: "save",
        createdAt: new Date().toISOString(),
        note: "Use your passphrase to restore.",
        hint: hint.trim(),
      };
      setDoneBackup(backupPayload);
      setStep("done");
      // Notify the parent AFTER committing the local done-state so a parent
      // re-render can't unmount this modal before "done" renders (DECISIONS.md
      // "Local state commits BEFORE parent notification").
      onComplete();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(msg || "Something went wrong — try again");
      console.error("OpenBook: protect (encrypt-in-place) failed", e);
      unblock();
    } finally {
      setWorking(false);
    }
  }

  // Explicit save — Web Share on iOS, <a download> fallback elsewhere. block()
  // is already held; idempotent. Fires onSaved ONLY on a real save.
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

  const canSubmit = pass.length >= 8 && pass === confirm && Boolean(hint.trim()) && !working;

  return (
    <>
      {/* Non-dismissing backdrop — high-stakes multi-field flow; an outside tap
          must NOT discard the entry. Exit via the X or Cancel. (QA 2026-06-23) */}
      <div className="fixed inset-0 z-[70] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]" />

      <div className="fixed inset-0 z-[70] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border border-amber-400/20 shadow-2xl overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] flex flex-col overflow-y-auto"
          style={{ backgroundColor: "#0f0f0f" }}
        >
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
            <div>
              <p className="text-sm font-semibold text-zinc-100">Add a passphrase</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {step === "done"
                  ? "Save your recovery file"
                  : "Locks your key so only you can use it"}
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
                      back into your account if you forget your passphrase.
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
                      Passphrase set. Save your recovery file now &mdash; with your passphrase,
                      it&apos;s the only way back into your account.
                    </p>
                  </div>
                  <div className="pt-3">
                    {/* Single save path: handleSaveBackup → on desktop an <a download>,
                        on iOS the Web Share drawer — and it marks the key saved + advances.
                        The old separate "Download" button skipped that bookkeeping (left the
                        key flagged unsaved). Consolidated to one button (QA, 2026-06-23). */}
                    <button
                      type="button"
                      onClick={() => void handleSaveBackup()}
                      disabled={sharing}
                      className="w-full bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) void handleProtect();
                }}
                className="space-y-3"
              >
                {/* iCloud Keychain anchor — hidden username so Keychain can save
                    the new credential for this account (DECISIONS.md "iCloud
                    Keychain requires a username anchor"). */}
                <input type="text" autoComplete="username" value={identity.name} readOnly hidden />
                <p className="text-[11px] text-amber-400/80 leading-relaxed">
                  Pick a passphrase only you know. You&apos;ll save a recovery file next.
                </p>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Passphrase (min 8 characters)"
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value);
                    setError("");
                  }}
                  onFocus={(e) => e.currentTarget.scrollIntoView({ block: "center" })}
                  className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm passphrase"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setError("");
                  }}
                  onFocus={(e) => e.currentTarget.scrollIntoView({ block: "center" })}
                  className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                />

                {/* Memory clue — mandatory */}
                <div className="border-l-2 border-amber-500/60 pl-2.5 space-y-1">
                  <label
                    htmlFor="protect-hint"
                    className="text-[11px] text-amber-400/80 font-medium block"
                  >
                    Memory clue
                  </label>
                  <input
                    id="protect-hint"
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
                    disabled={!canSubmit}
                    className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {working ? "Protecting..." : "Add passphrase"}
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
