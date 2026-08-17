import { canonicalTicker, isValidTicker } from "./ticker";

/**
 * `/send 1 $Occam @Bob` — handing somebody a ticket.
 *
 * ⚠ WHY THIS EXISTS. Until now units moved in exactly ONE place: a market fill,
 * where a buyer pays. So the only route from one account to another was to list a
 * ticket publicly and hope the right person bought it before anyone else did —
 * which is not a gift, it is an auction with a preferred bidder. Burning made the
 * gap obvious: a room owner's most natural act is handing out entry, and there was
 * no verb for it.
 *
 * ⚠ THE POST'S OWN SIGNATURE IS THE AUTHORISATION, and that is why this needs no
 * separate signed message the way listings do. `createPost` verifies a signature
 * over the content, and the content IS `/send 1 $OCCAM @BOB` — so the signature
 * covers the symbol, the quantity AND the recipient. A captured signature cannot
 * be replayed for a different amount or a different person, because changing
 * either changes the string that was signed. Getting this for free is the reason
 * a send is a command rather than a button posting to its own endpoint.
 *
 * ⚠ TWO WAYS TO NAME A RECIPIENT, BECAUSE ONE WOULD EXCLUDE MOST USERS. A nym is
 * readable but optional — most people are `anon_XXXX` and have never claimed one —
 * so an address works too, and resolves through `identity_addresses`. A pubkey is
 * deliberately NOT accepted: it is 66 characters of hex that nobody types
 * correctly, and a mistyped recipient on an irreversible transfer is the worst
 * failure this command has.
 *
 * ⚠ `@` FOR A PERSON, `$` FOR A TOKEN. Nyms are stored as ticker symbols and
 * render as `$Bob`, so `/send 1 $Occam $Bob` would be two `$` tokens whose meaning
 * depended on position. That parses, and it is exactly the kind of thing somebody
 * gets backwards once and cannot undo.
 *
 * Pure and dependency-free, like `buy-command.ts`: the compose box, the server
 * action and the charge all have to read the same command out of the same text.
 */

export type SendRecipient =
  /** A claimed nym, canonical UPPERCASE — resolved via `nyms.symbol`. */
  | { kind: "nym"; value: string }
  /** A BSV address — resolved via `identity_addresses`, or `nyms.address`. */
  | { kind: "address"; value: string };

export interface SendCommand {
  /** Canonical (UPPERCASE) symbol of the token being sent. */
  symbol: string;
  units: number;
  recipient: SendRecipient;
}

/**
 * The most units one command may send.
 *
 * ⚠ A TYPO GUARD, AND A TIGHTER ONE THAN `/buy` HAS. A buy is self-limiting
 * because the curve is quadratic — an over-large number simply cannot be paid for.
 * A send costs the sender nothing but the post, so `/send 10000 $X @Bob` when they
 * meant `1000` succeeds, irreversibly, and gives away nine thousand tickets. The
 * cap does not make that impossible, only harder to do by accident.
 */
export const MAX_SEND_UNITS = 10_000;

/** Same shape the balance and UTXO routes accept — mainnet P2PKH. */
const ADDRESS_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

/**
 * Parse a compose-box value as a send, or null if it is not one.
 *
 * ⚠ STRICT, AND MORE SO THAN `/buy`. A near-miss must fall through to being an
 * ordinary post rather than being guessed at — but the stakes are different in
 * kind here: a misparsed buy costs the buyer money they chose to spend, while a
 * misparsed send gives somebody else's property away to the wrong person with no
 * way back. `/send 1 $Occam to Bob` is a sentence, not an instruction.
 *
 * The count is optional and defaults to one, because `/send $Occam @Bob` is the
 * obvious way to hand over a single ticket. Separators are allowed in the count
 * (`1,000`, `1_000`) since that is where people type them.
 */
export function parseSendCommand(raw: string): SendCommand | null {
  const text = raw.trim();
  // Anchored at both ends: a send command is the WHOLE message. Trailing prose
  // would be text nobody stores, on a board whose promise is that what you wrote
  // is kept.
  const m =
    /^\/send\s+(?:([\d,_]+)\s+)?\$([A-Za-z][A-Za-z0-9]*)\s+(?:@([A-Za-z][A-Za-z0-9]*)|([13][a-km-zA-HJ-NP-Z1-9]{25,34}))$/i.exec(
      text
    );
  if (!m) return null;

  const symbol = canonicalTicker(`$${m[2]}`);
  if (!isValidTicker(symbol)) return null;

  let recipient: SendRecipient;
  if (m[3] !== undefined) {
    const nym = canonicalTicker(`$${m[3]}`);
    // A nym is a ticker symbol, so it answers to the same validity rule. If it
    // does not, there is no such nym and nothing to resolve.
    if (!isValidTicker(nym)) return null;
    recipient = { kind: "nym", value: nym };
  } else if (m[4] !== undefined) {
    // ⚠ RE-TESTED, NOT TRUSTED FROM THE GROUP. Base58 excludes 0/O/I/l, and the
    // alternation above already encodes that — but an address is the field where
    // a single wrong character sends somebody's property into a wallet nobody
    // holds the key to, so it is checked again against the canonical shape rather
    // than relying on one regex being right in two places.
    if (!ADDRESS_RE.test(m[4])) return null;
    recipient = { kind: "address", value: m[4] };
  } else {
    return null;
  }

  const rawCount = m[1];
  if (rawCount === undefined) return { symbol, units: 1, recipient };

  const digits = rawCount.replace(/[,_]/g, "");
  // A separator-only count (`/send ,,, $X @Bob`) leaves nothing to parse.
  if (digits === "") return null;
  const units = Number(digits);
  if (!Number.isSafeInteger(units) || units < 1 || units > MAX_SEND_UNITS) return null;

  return { symbol, units, recipient };
}

/** Whether a compose-box value would send units rather than post. */
export function isSendCommand(raw: string): boolean {
  return parseSendCommand(raw) !== null;
}

/**
 * The text a send is recorded as, on chain and in the feed.
 *
 * ⚠ CANONICAL, AND THE SERVER RE-DERIVES FROM IT. What the sender signs, what is
 * inscribed, what the feed shows and who actually receives the units are all this
 * one string — so the permanent record says exactly who was given what.
 * Round-trips through `parseSendCommand`, which is what the server calls on the
 * way back in.
 */
export function sendCommandText(cmd: SendCommand): string {
  const to = cmd.recipient.kind === "nym" ? `@${cmd.recipient.value}` : cmd.recipient.value;
  return `/send ${cmd.units} $${cmd.symbol} ${to}`;
}
