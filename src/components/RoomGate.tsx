"use client";

import { useEffect, useState } from "react";
import { getListings } from "@/app/actions";
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
  onBuyListing,
  onClose,
}: {
  access: RoomAccess;
  /** Mints a NEW ticket — the host owns posting, as it does for every other buy. */
  onBuy: (text: string) => void;
  /** Buys an EXISTING ticket from a holder, at their price. */
  onBuyListing: (listingId: number) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { requireIdentity } = useIdentityContext();
  const bsvPrice = useBsvPrice();
  const symbol = access.symbol ?? "";
  const usd = bsvPrice > 0 ? (access.priceSats / 1e8) * bsvPrice : null;

  /**
   * The cheapest ticket somebody is already holding and willing to sell.
   *
   * ⚠ THE OWNER ASKED FOR THIS ROUTE FIRST — *"or they can go to the market to
   * buy a cheaper ticket on the market instead"* — and it is the honest one to
   * lead with when it exists: the mint price is a CEILING, so an ask below it is
   * strictly better for the buyer. Showing only the door would be the interface
   * overcharging somebody on the platform's behalf.
   */
  const [ask, setAsk] = useState<{ id: number; priceSats: number } | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let live = true;
    void getListings(symbol)
      .then((rows) => {
        if (live) setAsk(rows[0] ? { id: rows[0].id, priceSats: rows[0].priceSats } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [symbol]);

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
    // Sits at the TOP of the thread, so no `min-h-full` centring — that was for
    // a card standing in for the whole conversation, and this one now leads it.
    <div className="flex justify-center pt-1 pb-4">
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

          {/* ⚠ THE CHEAPER OPTION LEADS, when there is one. A buyer offered two
              prices should be shown the lower one first; anything else is the
              interface working for the house. */}
          {ask && ask.priceSats < access.priceSats && (
            <button
              type="button"
              onClick={() => {
                if (!requireIdentity()) return;
                onBuyListing(ask.id);
              }}
              className="mt-4 w-full rounded-lg bg-amber-500 py-2.5 text-[13px] font-medium text-black transition-colors hover:bg-amber-400"
            >
              Buy from a holder — {ask.priceSats.toLocaleString()} sats
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              // Same gate every spending action uses — a locked reader is asked
              // to sign in rather than shown a purchase that would fail.
              if (!requireIdentity()) return;
              setConfirming(true);
            }}
            className={`mt-3 w-full rounded-lg py-2.5 text-[13px] font-medium transition-colors ${
              ask && ask.priceSats < access.priceSats
                ? "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                : "bg-amber-500 text-black hover:bg-amber-400"
            }`}
          >
            {ask && ask.priceSats < access.priceSats
              ? `Mint a new one — ${access.priceSats.toLocaleString()} sats`
              : "Buy a ticket"}
          </button>

          {/* Who already holds it — the roster a resale comes out of. */}
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

/**
 * The room's price, for people who are already in.
 *
 * ⚠ A HOLDER STILL WANTS THE NUMBER (owner, 2026-08-17). The door tells a
 * stranger what entry costs; this tells a member what their seat is now worth,
 * because that is the same figure — nobody rationally pays more second-hand
 * than a fresh ticket costs, so the mint price is the ceiling on what they
 * could sell for. Without it a holder has to leave the room to find out whether
 * the thing they are sitting in got more valuable.
 *
 * Sticky, deliberately: it is a live price, and a price that scrolls away is a
 * price you have to go looking for.
 */
export function RoomTicker({ access }: { access: RoomAccess }) {
  const bsvPrice = useBsvPrice();
  const symbol = access.symbol ?? "";
  const usd = bsvPrice > 0 ? (access.priceSats / 1e8) * bsvPrice : null;

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-1 border-b border-zinc-800/80 bg-black/85 px-4 py-1.5 backdrop-blur">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="font-medium text-amber-400">${titleCaseTicker(symbol)}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">
          you hold <span className="font-mono tabular-nums text-zinc-300">{access.held}</span>
        </span>
        <span className="ml-auto text-zinc-500">
          entry{" "}
          <span className="font-mono tabular-nums text-amber-400">
            {access.priceSats.toLocaleString()}
          </span>{" "}
          sats
          {usd !== null && (
            <span className="ml-1 font-mono tabular-nums text-zinc-600">
              (${usd < 0.01 ? usd.toFixed(5) : usd.toFixed(2)})
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
