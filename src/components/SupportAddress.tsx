"use client";

import { useState } from "react";

/**
 * The server wallet's address, published so anyone can top it up.
 *
 * ⚠ THIS REVERSES A DELIBERATE DECISION, KNOWINGLY. `/api/health` was built to
 * expose `addressConfigured: boolean` and NEVER the address itself. Publishing it
 * here is the owner's call, and the reasoning that makes it defensible:
 *
 *  - It is not a secret. The address is already inferable on-chain by anyone who
 *    looks at a post's OP_RETURN and follows the funding input, so publishing it
 *    reveals nothing that a motivated reader could not already derive.
 *  - It is a receive-only address. Knowing it permits paying in, never spending.
 *
 * What it DOES cost is pseudonymity of operations: balance and spending are now
 * trivially watchable rather than merely derivable. That is a real trade and the
 * reason `/api/health` still does not return it — this component is the single
 * intentional publication point.
 *
 * ⚠ THE ADDRESS IS DERIVED FROM `BSV_SERVER_WIF`, NEVER HARDCODED. A pasted
 * literal would keep pointing at a dead wallet after a key rotation, and people
 * would send funds to an address the server no longer controls. It comes in as a
 * prop from the server so a rotation updates it automatically.
 */
export function SupportAddress({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the address is visible and selectable anyway */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy the address that funds on-chain posting"
      className="w-full flex items-center justify-center gap-2 px-4 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors border-b border-zinc-900"
    >
      <span className="hidden sm:inline text-zinc-600">Posts are paid for on-chain —</span>
      <span className="text-zinc-600">keep it running:</span>
      <span className="font-mono text-amber-500/80 truncate max-w-[46vw] sm:max-w-none">
        {address}
      </span>
      <span className={`transition-opacity ${copied ? "text-emerald-500" : "text-zinc-600"}`}>
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
