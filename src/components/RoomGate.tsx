"use client";

import { useEffect, useState } from "react";
import type { RoomPosition as RoomPositionData } from "@/app/actions";
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
   * ⚠ THE MINT PRICE IS NOT A CEILING ON WHAT A HOLDER MAY ASK (owner,
   * 2026-08-17), and an earlier version of this file had that wrong in a way
   * that mattered. A holder can list ABOVE the current mint price — *"I can list
   * a ticket for $100 today, even though the platform price is $90"* — and that
   * is a LIMIT ORDER, not a mispricing. It fills when the curve rises past it,
   * which it does as the room fills. Refusing to show such an ask, or telling a
   * seller nobody will take it, was the interface arguing with the design.
   *
   * What the mint price actually is: the price of the LAST RESORT. Nobody has to
   * pay more than it, because minting a fresh unit is always available — so a
   * buyer picks whichever of the two is cheaper, and both are shown.
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
    // ⚠ FULL CONTENT WIDTH (owner, 2026-08-17). `max-w-sm` made a door narrower
    // than the conversation behind it, which read as a dialog that had wandered
    // into the page. It is not a dialog — it IS the page for somebody without a
    // ticket — so it takes the same column the posts do.
    <div className="pt-1 pb-4">
      <div className="w-full overflow-hidden rounded-2xl border border-amber-400/20 bg-[#0f0f0f]">
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

          {/* ⚠ THE CHEAPER OPTION LEADS. A buyer offered two prices should be
              shown the lower one first; anything else is the interface working
              for the house. An ask ABOVE the mint price is still a real offer —
              it just is not the one to lead with, because minting is cheaper
              today. */}
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
 * Your position in a room you are already in.
 *
 * ⚠ A HOLDER WANTS THE NUMBERS, NOT A PRICE TAG (owner, 2026-08-17). This was a
 * one-line strip showing the entry price. What somebody sitting on a position
 * actually needs is: how much of it they hold, what it cost them, what a fresh
 * unit costs today, and a way out — *"offer them the chance to sell (list)
 * their tokens on the market, how many, what price."*
 *
 * ⚠ THE MINT PRICE IS SHOWN AS "REPLACEMENT COST", NOT AS A VALUATION. Pricing
 * a whole holding at the current mint price would be a lie in the flattering
 * direction: the curve is what the NEXT unit costs, and dumping a thousand units
 * into the market would not clear anywhere near it. Cost, replacement cost and
 * realised proceeds are three facts; a "your position is worth £X" is a
 * projection, so it is not shown.
 *
 * ⚠ UNKNOWN COST IS REPORTED, NOT HIDDEN. Units minted before the price was
 * recorded have no basis, and the card says how many rather than quietly
 * averaging over the ones it can price.
 *
 * Sticky, because it is a live price and one that scrolls away has to be gone
 * looking for.
 */
export function RoomPosition({
  position,
  onSell,
}: {
  position: RoomPositionData;
  onSell: () => void;
}) {
  const bsvPrice = useBsvPrice();
  const usd = (sats: number) => (bsvPrice > 0 ? (sats / 1e8) * bsvPrice : null);
  const fmtUsd = (v: number | null) =>
    v === null ? "" : ` (≈ $${v < 0.01 ? v.toFixed(5) : v.toFixed(2)})`;
  const unpriced = Math.max(0, position.units - position.pricedUnits);
  const avg =
    position.pricedUnits > 0 ? Math.round(position.spentSats / position.pricedUnits) : null;

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-2 border-b border-zinc-800/80 bg-black/90 px-4 py-2 backdrop-blur">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-amber-400">
          ${titleCaseTicker(position.symbol)}
        </span>
        <span className="font-mono text-[13px] tabular-nums text-white">
          {position.units.toLocaleString()}
        </span>
        <span className="text-[11px] text-zinc-500">
          {position.units === 1 ? "ticket" : "tickets"}
        </span>
        <button
          type="button"
          onClick={onSell}
          className="ml-auto rounded-full border border-zinc-700 px-3 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-amber-400/50 hover:text-amber-300"
        >
          Sell
        </button>
      </div>

      <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-[10px]">
        <div>
          <dt className="text-zinc-600">You paid</dt>
          <dd className="font-mono tabular-nums text-zinc-300">
            {position.spentSats.toLocaleString()}
            <span className="text-zinc-600">{fmtUsd(usd(position.spentSats))}</span>
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600">Avg / ticket</dt>
          <dd className="font-mono tabular-nums text-zinc-300">
            {avg === null ? "—" : avg.toLocaleString()}
          </dd>
        </div>
        <div>
          {/* The honest label. It is what the NEXT one costs, which is the price
              a buyer can always fall back to — not what this holding would
              fetch if it were sold. */}
          <dt className="text-zinc-600">New one costs</dt>
          <dd className="font-mono tabular-nums text-amber-400">
            {position.mintPriceSats.toLocaleString()}
          </dd>
        </div>
      </dl>

      {(unpriced > 0 || position.listedUnits > 0 || position.receivedSats > 0) && (
        <p className="mt-1 text-[10px] text-zinc-600">
          {unpriced > 0 && (
            <span>
              {unpriced.toLocaleString()} minted before prices were recorded — no cost known.{" "}
            </span>
          )}
          {position.listedUnits > 0 && (
            <span>{position.listedUnits.toLocaleString()} listed for sale. </span>
          )}
          {position.receivedSats > 0 && (
            <span>{position.receivedSats.toLocaleString()} sats received from sales.</span>
          )}
        </p>
      )}
    </div>
  );
}
