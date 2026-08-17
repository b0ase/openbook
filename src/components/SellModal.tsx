"use client";

import { useCallback, useEffect, useState } from "react";
import { cancelListing, getListings, type ListingView, listUnits } from "@/app/actions";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useBsvPrice } from "@/hooks/useBsvPrice";
import { cancelListingMessage, listMessage } from "@/lib/listing-message";
import { mintPriceSats } from "@/lib/mint-price";
import { titleCaseTicker } from "@/lib/ticker";

/**
 * Offer units for sale, and take offers back.
 *
 * ⚠ AN ASK ABOVE THE MINT PRICE IS A LIMIT ORDER, NOT A MISTAKE (owner,
 * 2026-08-17). This file used to tell sellers "price above that and nobody will
 * take it", which is wrong and was actively bad advice: the mint price RISES as
 * the room fills, so an ask set above it today is filled the moment the curve
 * passes it. *"I can list a ticket for $100 today, even though the platform
 * price is $90. Eventually I'll sell my ticket for $100."*
 *
 * So the mint price is shown as INFORMATION — it is what a buyer pays if they
 * ignore you today — not as a cap on what may be asked.
 *
 * Listing is free and moves nothing: it is a signed offer, and the units only
 * change hands when somebody pays. That is why the seller signs the exact terms
 * (`listMessage`) — a signature over the symbol alone would authorise any
 * quantity at any price.
 */
export function SellModal({
  symbol,
  held,
  onClose,
  onChanged,
}: {
  symbol: string;
  /** Units the seller holds — the cap on what they can offer. */
  held: number;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { identity, sign } = useIdentityContext();
  const bsvPrice = useBsvPrice();
  const [units, setUnits] = useState("1");
  const [price, setPrice] = useState("");
  const [mine, setMine] = useState<ListingView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!identity) return;
    void getListings(symbol, identity.pubkey)
      .then((rows) => setMine(rows.filter((r) => r.mine)))
      .catch(() => {});
  }, [symbol, identity]);

  useEffect(refresh, [refresh]);

  const n = Number(units);
  const p = Number(price);
  const valid = Number.isSafeInteger(n) && n >= 1 && n <= held && Number.isSafeInteger(p) && p >= 1;
  const usd = valid && bsvPrice > 0 ? ((n * p) / 1e8) * bsvPrice : null;

  async function submit() {
    if (!identity || !valid || busy) return;
    setBusy(true);
    setError(null);
    const signed = await sign(listMessage(symbol, n, p));
    if (!signed) {
      setBusy(false);
      setError("Couldn't sign that — try again.");
      return;
    }
    const fd = new FormData();
    fd.set("symbol", symbol);
    fd.set("units", String(n));
    fd.set("price_sats", String(p));
    fd.set("pubkey", signed.pubkey);
    fd.set("signature", signed.signature);
    const res = await listUnits(fd);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.reason === "not_enough_units"
          ? "You don't have that many free to sell — some may already be listed."
          : res.reason === "rate_limited"
            ? "Too fast — try again in a moment."
            : "Couldn't create that offer."
      );
      return;
    }
    setPrice("");
    refresh();
    onChanged?.();
  }

  async function withdraw(id: number) {
    if (!identity || busy) return;
    setBusy(true);
    const signed = await sign(cancelListingMessage(id));
    if (!signed) {
      setBusy(false);
      return;
    }
    const fd = new FormData();
    fd.set("listing_id", String(id));
    fd.set("pubkey", signed.pubkey);
    fd.set("signature", signed.signature);
    await cancelListing(fd);
    setBusy(false);
    refresh();
    onChanged?.();
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[80] w-full cursor-default bg-black/75 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center px-6">
        <div
          className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-amber-400/20 bg-[#0f0f0f]"
          role="dialog"
          aria-modal="true"
          aria-label="Sell units"
        >
          <div className="h-[3px] bg-amber-400" />
          <div className="px-5 py-4">
            <h2 className="text-[15px] font-semibold tracking-tight">
              Sell <span className="text-amber-400">${titleCaseTicker(symbol)}</span>
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              You hold {held}. Minting a fresh unit costs{" "}
              <span className="font-mono tabular-nums text-amber-400">
                {mintPriceSats(held).toLocaleString()}
              </span>{" "}
              sats today. Ask below that and it can sell now; ask above it and it sells when the
              room fills enough to push the mint price past you.
            </p>

            <div className="mt-3 flex gap-2">
              <label className="flex-1 text-[11px] text-zinc-500">
                Units
                <input
                  inputMode="numeric"
                  value={units}
                  onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-black px-2 py-1.5 font-mono text-[13px] text-white outline-none focus:border-amber-400/50"
                />
              </label>
              <label className="flex-1 text-[11px] text-zinc-500">
                Sats each
                <input
                  inputMode="numeric"
                  value={price}
                  onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-black px-2 py-1.5 font-mono text-[13px] text-white outline-none focus:border-amber-400/50"
                />
              </label>
            </div>

            {valid && (
              <p className="mt-2 text-[11px] text-zinc-500">
                Total{" "}
                <span className="font-mono tabular-nums text-zinc-300">
                  {(n * p).toLocaleString()}
                </span>{" "}
                sats
                {usd !== null && (
                  <span className="text-zinc-600">
                    {" "}
                    (≈ ${usd < 0.01 ? usd.toFixed(5) : usd.toFixed(2)})
                  </span>
                )}
              </p>
            )}

            {error && <p className="mt-2 text-[12px] text-red-400">{error}</p>}

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-zinc-800 py-2 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Close
              </button>
              <button
                type="button"
                disabled={!valid || busy}
                onClick={submit}
                className="flex-1 rounded-lg bg-amber-500 py-2 text-[13px] font-medium text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                List them
              </button>
            </div>

            {mine.length > 0 && (
              <div className="mt-4 border-t border-zinc-800/80 pt-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Your offers</p>
                <ul className="mt-2 space-y-1.5">
                  {mine.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="font-mono tabular-nums text-zinc-400">
                        {l.unitsLeft} × {l.priceSats.toLocaleString()} sats
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => withdraw(l.id)}
                        className="text-[11px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-red-400"
                      >
                        Withdraw
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
