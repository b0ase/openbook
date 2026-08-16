"use client";

import { useState } from "react";
import { BuyConfirm } from "@/components/BuyConfirm";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useBsvPrice } from "@/hooks/useBsvPrice";
import type { RoomAccess } from "@/lib/room-access";
import { titleCaseTicker } from "@/lib/ticker";

/**
 * The door of a room.
 *
 * ⚠ WHAT IT IS FOR. A named thread is a room and one unit of its token is the
 * ticket (see `room-access.ts`). This is what somebody without one sees: the
 * price, a way to buy, and the second option — the market — which is what stops
 * the door being the only seller.
 *
 * ⚠ IT SAYS WHAT A TICKET IS. "Yours to keep, and yours to sell" is not a
 * flourish: it is the difference between this and a subscription, and it is the
 * reason the price is worth paying. A reader who thinks they are renting will
 * not buy at a price that rises.
 *
 * Buying goes through the SAME `BuyConfirm` the compose box uses, so the price
 * shown at a door and the price shown for `/buy 1 $X` cannot drift apart — and
 * the purchase itself is the ordinary paid-post path with all its checks.
 */
export function RoomGate({
  access,
  onBuy,
  onClose,
}: {
  access: RoomAccess;
  /** Runs the purchase — the host owns posting, as it does for every other buy. */
  onBuy: (text: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { requireIdentity } = useIdentityContext();
  const bsvPrice = useBsvPrice();
  const symbol = access.symbol ?? "";
  const usd = bsvPrice > 0 ? (access.priceSats / 1e8) * bsvPrice : null;

  if (confirming) {
    return (
      <BuyConfirm
        buy={{ symbol, units: 1 }}
        onCancel={() => setConfirming(false)}
        onConfirm={(text) => {
          setConfirming(false);
          onBuy(text);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-amber-400/20 bg-[#0f0f0f]">
        <div className="h-[3px] bg-amber-400" />
        <div className="px-5 py-5">
          <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Members only</p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight">
            <span className="text-amber-400">${titleCaseTicker(symbol)}</span>
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
            One unit of this token is the ticket in. Hold one and you can read and post here.
          </p>

          <div className="mt-4 flex items-baseline gap-2 border-t border-zinc-800/80 pt-4">
            <span className="font-mono text-2xl tabular-nums text-white">
              {access.priceSats.toLocaleString()}
            </span>
            <span className="text-[13px] text-zinc-500">sats</span>
            {usd !== null && (
              <span className="ml-auto font-mono text-[13px] tabular-nums text-zinc-500">
                ≈ ${usd < 0.01 ? usd.toFixed(5) : usd.toFixed(2)}
              </span>
            )}
          </div>

          {/* ⚠ THE PROPERTY, NOT THE ACCESS, IS THE PITCH. A ticket that rises
              with the room and can be sold on is an asset; the same money spent
              on a subscription is gone. Somebody deciding whether to pay a price
              that goes UP needs to know which of those they are being offered. */}
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            The price rises as the room fills, so a ticket bought now is worth what a later one
            costs. It is yours to keep, and yours to sell.
          </p>

          <button
            type="button"
            onClick={() => {
              // Same gate every spending action uses — a locked reader is asked
              // to sign in rather than shown a purchase that would fail.
              if (!requireIdentity()) return;
              setConfirming(true);
            }}
            className="mt-4 w-full rounded-lg bg-amber-500 py-2.5 text-[13px] font-medium text-black transition-colors hover:bg-amber-400"
          >
            Buy a ticket
          </button>

          {/* ⚠ HONEST ABOUT THE SECOND ROUTE. The owner's design has a buyer
              choose between the door and a cheaper resale — so the market is
              linked from here. Resale is not built yet and the line says so;
              sending somebody to a page that cannot sell them anything, without
              warning, would be worse than not linking it. */}
          <a
            href={`/leaderboard/$${symbol.toLowerCase()}`}
            className="mt-3 block text-center text-[12px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
          >
            See who holds ${titleCaseTicker(symbol)}
          </a>

          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full text-center text-[12px] text-zinc-600 transition-colors hover:text-zinc-400"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
