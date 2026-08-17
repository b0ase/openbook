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
 * ⚠ WHAT IT IS FOR. A named thread is a room and a unit of its token is the
 * ticket — BURNED on the way in (see `room-access.ts`). This is what somebody
 * outside sees: the price, a way to buy, and the market as a second seller so the
 * door is not the only one.
 *
 * ⚠ TWO STATES, BECAUSE BUYING AND ENTERING ARE NOW DIFFERENT ACTS. Somebody with
 * no ticket is being sold one. Somebody who HOLDS one is being asked to spend it,
 * and told plainly that it will be destroyed — a door that quietly consumed
 * property on a tap would be the interface taking a decision that is not its own.
 *
 * ⚠ THE OLD PITCH HAD TO GO, AND THE HONEST ONE IS NOT WEAKER. This card used to
 * say a ticket was *"yours to keep, and yours to sell"*. Under burn-on-entry that
 * is false for a ticket you actually use: you keep the membership, not the token.
 * What remains true, and is the real argument, is that entry is bought ONCE and
 * lasts — and that the price only goes up, so the cheapest this room will ever be
 * is now. A subscription has neither property.
 *
 * Buying goes through the SAME `BuyConfirm` the compose box uses, so the price
 * shown at a door and the price shown for `/buy 1 $X` cannot drift apart — and
 * the purchase itself is the ordinary paid-post path with all its checks.
 */
export function RoomGate({
  access,
  onBuy,
  onBuyListing,
  onEnter,
  onClose,
}: {
  access: RoomAccess;
  /** Mints a NEW ticket — the host owns posting, as it does for every other buy. */
  onBuy: (text: string) => void;
  /** Buys an EXISTING ticket from a holder, at their price. */
  onBuyListing: (listingId: number) => void;
  /** Burns one held ticket and admits the reader. Destroys a unit. */
  onEnter: () => void;
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
            {access.held > 0 ? (
              <>
                You hold{" "}
                {access.held === 1 ? "a ticket" : `${access.held.toLocaleString()} tickets`}.
                Burning one lets you in for good — the ticket is gone, the seat is yours.
              </>
            ) : (
              <>A ticket gets you in, and is burned at the door. Entry is once, and permanent.</>
            )}
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

          {/* ⚠ WHAT IS STILL TRUE AFTER BURNING, AND ONLY THAT. The old line here
              promised a ticket was "yours to keep, and yours to sell", which a
              burned one is not. The surviving argument is better anyway: the
              price only rises, so today is the cheapest this room will ever be,
              and what you buy is permanent rather than rented. An UNUSED ticket
              is still property and still sellable — said where it applies. */}
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            The price rises as the room fills, so this is the cheapest entry will ever be. You pay
            once and you are in for good — no renewal, nothing to keep paying.
            {access.held > 1 && " Tickets you do not burn stay yours to sell."}
          </p>

          {access.held > 0 ? (
            /* ⚠ THE ONLY BUTTON THAT DESTROYS SOMETHING, AND IT SAYS SO. Burning
               is irreversible and the label carries the word rather than hiding
               it behind "Enter" — somebody should not learn what happened from
               their balance afterwards. */
            <button
              type="button"
              onClick={() => {
                if (!requireIdentity()) return;
                onEnter();
              }}
              className="mt-4 w-full rounded-lg bg-amber-500 py-2.5 text-[13px] font-medium text-black transition-colors hover:bg-amber-400"
            >
              Burn a ticket and come in
            </button>
          ) : (
            <>
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
            </>
          )}

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
 * ⚠ A MEMBER'S BALANCE IS ZERO BY CONSTRUCTION, so this card cannot lead with
 * holdings the way it did. The ticket was burned at the door; what a member has is
 * a seat, plus whatever spare stock they never spent. So the headline is now the
 * membership — what entry cost against what it costs today, which is the
 * comparison the owner asked this card to make in the first place. The holdings
 * rows stay, and simply say "none" for the ordinary member who spent their only
 * ticket, because that is the truth and hiding it would make the burn feel like a
 * loss nobody acknowledged.
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
  onSend,
}: {
  position: RoomPositionData;
  onSell: () => void;
  /** Pre-fill the composer with a `/send` for this room's token. */
  onSend: () => void;
}) {
  const bsvPrice = useBsvPrice();
  const usd = (sats: number) => (bsvPrice > 0 ? (sats / 1e8) * bsvPrice : null);
  const fmtUsd = (v: number | null) =>
    v === null ? "" : ` (≈ $${v < 0.01 ? v.toFixed(5) : v.toFixed(2)})`;
  const unpriced = Math.max(0, position.units - position.pricedUnits);
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-2 border-b border-zinc-800/80 bg-black/90 px-4 py-2 backdrop-blur">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-amber-400">
          ${titleCaseTicker(position.symbol)}
        </span>
        {/* The membership, not the balance — the balance is the row below. */}
        <span className="text-[11px] text-zinc-400">Member</span>
        {/* ⚠ SELL ONLY WHAT EXISTS. A member who burned their only ticket has
            nothing to list, and a Sell button that opens onto a zero balance is
            an interface offering something it cannot do. */}
        {position.units > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            {/* ⚠ GIVING AND SELLING ARE DIFFERENT ACTS AND BOTH BELONG HERE. A
                room owner's most natural move is handing somebody entry, and
                until this existed the only route to another account was to list
                publicly and hope the right person bought it first — an auction
                with a preferred bidder, not a gift. It pre-fills the composer
                rather than opening a modal of its own: the command is what gets
                signed and inscribed, so showing it is also teaching it. */}
            <button
              type="button"
              onClick={onSend}
              className="rounded-full border border-zinc-700 px-3 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-amber-400/50 hover:text-amber-300"
            >
              Send
            </button>
            <button
              type="button"
              onClick={onSell}
              className="rounded-full border border-zinc-700 px-3 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-amber-400/50 hover:text-amber-300"
            >
              Sell {position.units.toLocaleString()}
            </button>
          </div>
        )}
      </div>

      <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-[10px]">
        <div>
          {/* What the door charged THIS member, from the burn that admitted them
              — not the sum of everything they ever spent on the token, which is
              a different and less useful number. */}
          <dt className="text-zinc-600">Entry cost you</dt>
          <dd className="font-mono tabular-nums text-zinc-300">
            {position.entryPaidSats === null ? (
              "—"
            ) : (
              <>
                {position.entryPaidSats.toLocaleString()}
                <span className="text-zinc-600">{fmtUsd(usd(position.entryPaidSats))}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          {/* The honest label. It is what the NEXT one costs, which is what a new
              member would pay today — not what anything here would fetch. */}
          <dt className="text-zinc-600">Entry costs now</dt>
          <dd className="font-mono tabular-nums text-amber-400">
            {position.mintPriceSats.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600">Spare tickets</dt>
          <dd className="font-mono tabular-nums text-zinc-300">
            {position.units.toLocaleString()}
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
