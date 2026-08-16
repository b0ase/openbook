import { canonicalTicker, isValidTicker } from "./ticker";

/**
 * Handing a `$Ticker` to somebody else.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Every post runs `registerTickers`, which registers
 * each mentioned symbol to the POSTER. So merely *writing about* an unclaimed
 * name founds it — the owner discovered this by explaining an idea in a post and
 * inadvertently founding two tickers doing it. Without transfer, a name founded
 * by accident, or by the wrong account, can never be put right: `symbol` is a
 * PRIMARY KEY, so there is no second instance and no way back.
 *
 * ⚠ A TRANSFER IS A POST, EXACTLY AS A CLAIM IS. Claiming announces itself in a
 * signed, paid, inscribed post; an ownership CHANGE is at least as consequential
 * and gets the same treatment, for the same reason — on a board whose whole
 * proposition is a permanent public record, the moment a name changed hands must
 * be in that record, not only in a database row that could be edited later.
 *
 * The message below is what the current owner signs. It is the single source
 * shared by the client that signs it and the server that verifies it: if the two
 * ever built this string separately they would eventually disagree by a space,
 * and every transfer would fail verification with nothing to point at.
 */

/** The recipient is identified by their PUBLIC KEY. */
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/i;

/**
 * Why a pubkey and not an address: ticker ownership is stored as `tickers.pubkey`
 * and every ownership check compares pubkeys, so an address would have to be
 * resolved back to a key — and that resolution fails precisely for a brand-new
 * account that has never posted, which is the most likely recipient of a name
 * somebody is setting up for them. A public key is public; asking for it leaks
 * nothing.
 */
export function isValidRecipientPubkey(pubkey: unknown): pubkey is string {
  return typeof pubkey === "string" && PUBKEY_RE.test(pubkey);
}

/**
 * The announcement post — which IS the signed message. There is deliberately no
 * second, separate "transfer:…" string to sign.
 *
 * `claimNym` already established the pattern: *"the signed message must be
 * exactly what gets posted"*, and `createPost` verifies the author's signature
 * over the post content. Since this sentence names both the symbol and the
 * recipient, that one signature already binds both — a second signed string
 * would be a second thing that can drift out of step with the first, verifying
 * nothing the content signature does not already cover.
 *
 * ⚠ BOTH PARTIES MUST STAY IN THIS STRING. Sign only the symbol and a captured
 * signature could be redirected to any recipient; sign only the recipient and
 * one signature would move every ticker the owner holds. The symbol is
 * canonicalised so `$occam` and `$OCCAM` cannot yield two different signatures
 * for one transfer, and the key is lowercased for the same reason.
 *
 * Replay is handled by ownership, not by a nonce: re-submitting a past transfer
 * fails because the sender no longer holds the name.
 */
export function tickerTransferAnnouncement(symbol: string, toPubkey: string): string {
  return `Transferring $${canonicalTicker(symbol)} to ${toPubkey.toLowerCase()}`;
}

export type TransferValidation = { ok: true } | { ok: false; reason: TransferRejection };

export type TransferRejection =
  | "invalid_symbol"
  | "invalid_recipient"
  /** Sending a name to the account that already holds it — a no-op that would still charge. */
  | "same_owner";

/**
 * Everything checkable without touching the database.
 *
 * Kept separate and pure so the rules are testable on their own, and so the
 * client can refuse an obviously bad transfer before it costs the user a post.
 */
export function validateTransfer(
  symbol: string,
  toPubkey: string,
  fromPubkey: string
): TransferValidation {
  if (!isValidTicker(canonicalTicker(symbol))) return { ok: false, reason: "invalid_symbol" };
  if (!isValidRecipientPubkey(toPubkey)) return { ok: false, reason: "invalid_recipient" };
  // Compared case-insensitively: the same key written in different cases is the
  // same key, and charging somebody to send a name to themselves is a bug.
  if (toPubkey.toLowerCase() === fromPubkey.toLowerCase()) {
    return { ok: false, reason: "same_owner" };
  }
  return { ok: true };
}
