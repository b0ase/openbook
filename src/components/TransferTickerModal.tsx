"use client";

import { useEffect, useState } from "react";
import { getPostingMode, transferTicker } from "@/app/actions";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { isValidRecipientPubkey, tickerTransferAnnouncement } from "@/lib/ticker-transfer";

/**
 * Hand a `$Ticker` to another identity.
 *
 * ⚠ THIS IS IRREVERSIBLE AND THE COPY HAS TO SAY SO. Once the name moves, the
 * only way back is for the new holder to send it back — there is no undo, no
 * support desk, and no second instance of a symbol. The confirm step is
 * deliberately a typed confirmation of the symbol rather than a single button:
 * the failure being guarded against is not "clicked the wrong button", it is
 * "pasted the wrong key", and a second look at the name is the cheapest place to
 * catch that.
 *
 * The recipient is identified by PUBLIC KEY, not an address, because ticker
 * ownership is stored as a pubkey. See `ticker-transfer.ts`.
 */
export function TransferTickerModal({
  open,
  symbol,
  onClose,
  onTransferred,
}: {
  open: boolean;
  symbol: string;
  onClose: () => void;
  onTransferred: (symbol: string) => void;
}): React.JSX.Element | null {
  const { identity, sign } = useIdentityContext();
  const [to, setTo] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTo("");
      setConfirmText("");
      setState("idle");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const recipientOk = isValidRecipientPubkey(to.trim());
  const sameOwner = identity ? to.trim().toLowerCase() === identity.pubkey.toLowerCase() : false;
  const confirmed = confirmText.trim().toUpperCase() === symbol.toUpperCase();
  const ready = recipientOk && !sameOwner && confirmed && state === "idle";

  async function handleTransfer() {
    if (!identity || !ready) return;
    setState("sending");
    setError(null);
    try {
      const toPubkey = to.trim().toLowerCase();
      // The announcement IS the signed message — see ticker-transfer.ts.
      const content = tickerTransferAnnouncement(symbol, toPubkey);
      const signed = await sign(content);
      if (!signed) {
        setError("Couldn't sign that — try again.");
        setState("idle");
        return;
      }

      const fd = new FormData();
      fd.set("symbol", symbol);
      fd.set("to_pubkey", toPubkey);
      fd.set("content", content);
      fd.set("author", identity.name);
      fd.set("pubkey", signed.pubkey);
      fd.set("signature", signed.signature);

      // A transfer is a post, so it costs what a post costs. Same shared path as
      // the compose box and the name claim — see pay-for-post.ts for why every
      // route to createPost has to come through one place.
      const mode = await getPostingMode();
      const { payForPost } = await import("@/services/bsv/pay-for-post");
      const paid = await payForPost({
        mode,
        wif: identity.wif,
        address: identity.address,
        content,
        author: identity.name,
        sig: signed.signature,
        pubkey: signed.pubkey,
        parent: null,
      });
      if (!paid.ok) {
        setError(
          paid.status === "insufficient_funds" || paid.status === "no_utxos"
            ? "Not enough funds to transfer — add some and try again. Nothing was spent."
            : "Couldn't pay for that transfer — nothing was spent. Try again."
        );
        setState("idle");
        return;
      }
      if (paid.rawTx) fd.set("raw_tx", paid.rawTx);

      const res = await transferTicker(fd);
      if (res.ok) {
        setState("done");
        onTransferred(res.symbol);
        return;
      }
      setError(
        res.reason === "not_owner"
          ? "You don't hold that name any more."
          : res.reason === "invalid_recipient"
            ? "That isn't an account key. Ask them for their account key, not their address."
            : res.reason === "same_owner"
              ? "That's your own account."
              : "Couldn't transfer that — try again."
      );
      setState("idle");
    } catch {
      setError("Couldn't transfer that — try again.");
      setState("idle");
    }
  }

  return (
    <>
      {/* Backdrop as a real button, matching SignInModal — a div with an
          onClick is not reachable by keyboard and fails a11y lint. */}
      <button
        type="button"
        className="fixed inset-0 z-[80] w-full cursor-default bg-black/75 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[80] flex items-start justify-center px-6 pt-[6svh]">
        <div
          className="pointer-events-auto max-h-[80svh] w-full max-w-sm overflow-y-auto rounded-xl border border-amber-400/20 bg-[#0f0f0f] shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label={`Transfer $${symbol}`}
        >
          <div className="h-0.5 rounded-t-xl bg-amber-400/60" />
          <div className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Transfer ${symbol}</h2>
              <button
                type="button"
                onClick={onClose}
                className="text-zinc-500 hover:text-zinc-300"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {state === "done" ? (
              <div className="space-y-3">
                <p className="text-sm text-zinc-300">
                  <span className="text-amber-400">${symbol}</span> now belongs to that account.
                  They can adopt it as their name from their own wallet.
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full rounded-lg bg-amber-500 py-2 text-sm font-medium text-black hover:bg-amber-400"
                >
                  Got it
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-zinc-400">
                  Sending <span className="text-amber-400">${symbol}</span> to another account. This
                  is permanent — only they can send it back. The transfer is announced in a post, so
                  it costs what a post costs.
                </p>

                <label className="block text-xs text-zinc-500" htmlFor="transfer-to">
                  Their account key
                </label>
                <input
                  id="transfer-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="02… or 03…"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 font-mono text-xs text-white placeholder:text-zinc-700 focus:border-amber-400/50 focus:outline-none"
                />
                {to.trim() !== "" && !recipientOk && (
                  <p className="text-xs text-red-400">
                    That isn't an account key. An address (starting 1…) won't work — ask them for
                    their account key.
                  </p>
                )}
                {sameOwner && <p className="text-xs text-red-400">That's your own account.</p>}

                <label className="block text-xs text-zinc-500" htmlFor="transfer-confirm">
                  Type <span className="font-mono text-zinc-300">{symbol}</span> to confirm
                </label>
                <input
                  id="transfer-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 font-mono text-xs text-white focus:border-amber-400/50 focus:outline-none"
                />

                {error && <p className="text-xs text-red-400">{error}</p>}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 rounded-lg border border-zinc-800 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleTransfer}
                    disabled={!ready}
                    className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {state === "sending" ? "Sending…" : "Transfer"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
