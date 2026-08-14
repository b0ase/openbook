"use client";

import { useEffect, useState } from "react";
import { claimNym, resolveTickers } from "@/app/actions";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { canonicalTicker, isValidTicker, titleCaseTicker } from "@/lib/ticker";

/**
 * Adopt a public name — a `$Nym`.
 *
 * ⚠ CLAIMING POSTS IT. This is not a settings field that writes a row; it writes
 * a POST that claims the name, signed by the user, anchored on-chain, obeying
 * first-claim-wins through the same PRIMARY KEY as every other ticker. See
 * `claimNym` for why: a ticker names a THREAD, so a name with no content behind
 * it would need a second kind of ticker and a second set of rules. It also means
 * the nym's thread becomes the user's profile at no extra cost.
 *
 * The consequence to keep in the copy: **this is public and permanent.** Users
 * arriving from ordinary web products expect a username to be a private setting
 * they can change back. This one is a claim on a shared namespace that anyone can
 * cite, and the post announcing it cannot be unwritten.
 */
export function NymModal({
  open,
  onClose,
  current,
  onClaimed,
}: {
  open: boolean;
  onClose: () => void;
  current: string | null;
  onClaimed: (symbol: string) => void;
}) {
  const { identity, sign } = useIdentityContext();
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "claiming">("idle");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canonical = canonicalTicker(value.trim().replace(/^\$+/, ""));
  const valid = isValidTicker(canonical);

  useEffect(() => {
    if (!open) {
      setValue("");
      setAvailable(null);
      setError(null);
      setState("idle");
    }
  }, [open]);

  // Availability is advisory only — two people can pass this check at the same
  // moment. The claim itself is what decides, and it reports back honestly.
  useEffect(() => {
    if (!valid) {
      setAvailable(null);
      return;
    }
    let live = true;
    setState("checking");
    const t = setTimeout(() => {
      void resolveTickers([canonical])
        .then((r) => {
          if (live) setAvailable(!r[canonical]);
        })
        .finally(() => {
          if (live) setState("idle");
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [canonical, valid]);

  // Escape closes. Listens on `document`, not on the wrapper — a keydown handler
  // on the container only fires when focus is already inside it, so opening the
  // modal and immediately pressing Escape did nothing.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function handleClaim() {
    if (!identity || !valid) return;
    setState("claiming");
    setError(null);
    try {
      // The signed message must be exactly what gets posted — claimNym forwards
      // this straight to createPost, which verifies the signature over content.
      const content = `I'm $${titleCaseTicker(canonical)}`;
      const signed = await sign(content);
      if (!signed) {
        setError("Couldn't sign that — try again.");
        setState("idle");
        return;
      }
      const fd = new FormData();
      fd.set("symbol", canonical);
      fd.set("content", content);
      fd.set("author", identity.name);
      fd.set("pubkey", signed.pubkey);
      fd.set("signature", signed.signature);

      const res = await claimNym(fd);
      if (res.ok) {
        onClaimed(res.symbol);
        onClose();
        return;
      }
      setError(
        res.reason === "taken"
          ? "Somebody already has that name."
          : res.reason === "invalid"
            ? "Names start with a letter and can be up to 16 characters."
            : "Couldn't post that — try again."
      );
    } catch {
      setError("Couldn't claim that — try again.");
    }
    setState("idle");
  }

  return (
    <>
      {/* Backdrop click closes. A real <button> rather than a click handler on a
          static div — same pattern as SignInModal, and it keeps the backdrop
          keyboard-reachable instead of being a mouse-only target. */}
      <button
        type="button"
        className="fixed inset-0 z-[60] w-full bg-black/70 cursor-default"
        aria-label="Close"
        onClick={onClose}
      />

      <div className="fixed inset-0 z-[60] flex items-center justify-center px-4 pointer-events-none">
        <div
          className="w-full max-w-sm overflow-hidden rounded-2xl border border-amber-400/20 bg-[#0f0f0f] pointer-events-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Choose your name"
        >
          <div className="h-0.5 bg-gradient-to-r from-amber-500/60 to-amber-400/20" />
          <div className="flex items-center justify-between px-4 pt-3.5">
            <h2 className="text-sm font-semibold">Choose your name</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-2 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ✕
            </button>
          </div>

          <div className="px-4 pb-4 pt-3 space-y-3">
            {current && (
              <p className="text-[12px] text-zinc-500">
                You go by <span className="text-amber-400">${titleCaseTicker(current)}</span>.
                Picking a new one replaces it &mdash; you keep the old name, it just stops being the
                one you show.
              </p>
            )}

            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-lg font-semibold">$</span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Harry"
                maxLength={16}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Your name"
                className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
              />
            </div>

            {value.trim() && !valid && (
              <p className="text-[12px] text-zinc-500">
                Names start with a letter, then letters or numbers, up to 16 characters.
              </p>
            )}
            {valid && available === false && (
              <p className="text-[12px] text-zinc-500">
                <span className="text-amber-400">${titleCaseTicker(canonical)}</span> is already
                taken.
              </p>
            )}
            {valid && available === true && (
              <p className="text-[12px] text-emerald-500/90">
                ${titleCaseTicker(canonical)} is free.
              </p>
            )}

            {/* ⚠ Do not soften this. A username elsewhere is a private setting you
              can change back; this is a claim on a shared namespace, announced in
              a post that cannot be unwritten. */}
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
              Claiming posts it. Your name becomes a thread anyone can link to, first come first
              served, and the post announcing it is permanent.
            </p>

            {error && <p className="text-[12px] text-amber-400">{error}</p>}

            <div className="flex gap-2 pt-0.5">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-zinc-800 px-3 py-2 text-[13px] text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClaim}
                disabled={!valid || available === false || state === "claiming" || !identity}
                className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-[13px] font-medium text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                {state === "claiming" ? "Claiming…" : "Claim it"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
