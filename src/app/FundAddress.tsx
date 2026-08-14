"use client";

import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useInstallContext } from "@/contexts/InstallContext";

interface FundAddressProps {
  address: string;
  bootPrice?: number;
  balance?: number;
  /** Network fee the boot tx needs ON TOP of bootPrice (from the tx builder).
   * Optional — the plain deposit view (no boot in flight) omits it. */
  fee?: number;
  onClose: () => void;
  /** Opens the save-recovery flow. Shown when the user isn't backed up yet —
   * the value-gate hides the deposit address until then (see body). */
  onSecure?: () => void;
}

export function FundAddress({
  address,
  bootPrice,
  balance,
  fee,
  onClose,
  onSecure,
}: FundAddressProps) {
  const [copied, setCopied] = useState(false);
  // Value-gate (detection-INDEPENDENT funds floor): don't reveal the deposit
  // address until the account is backed up, so real money can't land on a key
  // the user can't recover (an in-app throwaway, or a normal browser whose
  // storage later clears). See DECISIONS "value-gate".
  const { backedUp } = useInstallContext();

  function handleCopy() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // A boot actually needs price + network fee. Top-up shortfall is measured
  // against that total so "you have enough" can't disagree with the builder.
  const required = bootPrice !== undefined ? bootPrice + (fee ?? 0) : undefined;
  const shortfall =
    required !== undefined && balance !== undefined && balance < required
      ? required - balance
      : null;

  return (
    <>
      {/* Backdrop — full-screen click target for dismiss */}
      <button
        type="button"
        className="fixed inset-0 z-[60] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out] cursor-default"
        aria-label="Close"
        onClick={onClose}
      />

      {/* Modal — pinned to top of viewport (iOS-native pattern, shared
          with the other modals for visual consistency). */}
      <div className="fixed inset-0 z-[60] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
        <div
          className="w-full max-w-sm rounded-2xl border border-amber-400/20 shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] overflow-y-auto"
          style={{ backgroundColor: "#0f0f0f" }}
        >
          {/* Gold top stripe */}
          <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
            <p className="text-sm font-semibold text-zinc-100">Deposit</p>
            <button
              type="button"
              onClick={onClose}
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

          {/* Body — value-gate: deposit address stays hidden until backed up. */}
          {backedUp ? (
            <div className="px-5 py-5 space-y-3">
              {/* QR hero — high-contrast white square scans reliably across all wallets */}
              <div className="flex justify-center">
                <div className="bg-white rounded-lg p-2">
                  <QRCodeSVG value={address} size={180} bgColor="#ffffff" fgColor="#000000" />
                </div>
              </div>

              {/* Balance + boot cost breakdown (only when boot context exists) */}
              {bootPrice ? (
                balance !== undefined ? (
                  <div className="bg-zinc-800/60 rounded-lg px-3 py-2.5 text-xs space-y-1">
                    <div className="flex justify-between text-zinc-400">
                      <span>Your balance</span>
                      <span className="font-mono text-zinc-200">
                        {balance.toLocaleString()} sats
                      </span>
                    </div>
                    <div className="flex justify-between text-zinc-400">
                      <span>Boost costs</span>
                      <span className="font-mono text-zinc-200">
                        {bootPrice.toLocaleString()} sats
                      </span>
                    </div>
                    {fee !== undefined && fee > 0 && (
                      <div className="flex justify-between text-zinc-400">
                        <span>Network fee</span>
                        <span className="font-mono text-zinc-200">{fee.toLocaleString()} sats</span>
                      </div>
                    )}
                    {shortfall !== null && (
                      <div className="flex justify-between text-amber-400 pt-1 border-t border-zinc-700/60">
                        <span>Top up needed</span>
                        <span className="font-mono">{shortfall.toLocaleString()} sats</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400">
                    Send BSV to this address to keep booting posts.
                  </p>
                )
              ) : (
                <p className="text-xs text-zinc-400">Send BSV to your address below.</p>
              )}

              {/* Address (click-to-copy) */}
              <button
                type="button"
                onClick={handleCopy}
                className="w-full text-left bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-3 font-mono text-xs text-zinc-200 break-all cursor-pointer hover:bg-zinc-800 transition-colors"
              >
                {address}
              </button>

              <button
                type="button"
                onClick={handleCopy}
                className="w-full bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors"
              >
                {copied ? "Copied!" : "Copy Address"}
              </button>
            </div>
          ) : (
            <div className="px-5 py-6 space-y-4">
              <p className="text-sm leading-relaxed text-zinc-300">
                Save your account first. Once you add money, losing this device without a recovery
                file means losing those funds — it only takes a moment.
              </p>
              <button
                type="button"
                onClick={() => {
                  onSecure?.();
                  onClose();
                }}
                className="w-full bg-amber-400 text-black rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-amber-300 transition-colors"
              >
                Save my account
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
