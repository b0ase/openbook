/**
 * The exact strings a seller and a buyer sign.
 *
 * ⚠ ONE SOURCE, BYTE FOR BYTE, for the reason `boot-message.ts` exists: the
 * client signs and the server verifies, and a signature over a string that
 * differs by a separator is simply invalid. Building the message on both sides
 * from two literals is a bug that only shows up in production, on the money
 * path, as "it just doesn't work".
 *
 * Each message names EVERY term it authorises. A signature over `list:$OCCAM`
 * alone would authorise any quantity at any price — so the units and the price
 * are in the string, and changing either invalidates it.
 */

/** What a seller signs to offer units. */
export function listMessage(symbol: string, units: number, priceSats: number): string {
  return `list:${symbol}:${units}:${priceSats}`;
}

/** What a seller signs to withdraw an offer. */
export function cancelListingMessage(listingId: number): string {
  return `cancel-listing:${listingId}`;
}

/**
 * What a buyer signs to claim a fill.
 *
 * ⚠ THE TXID IS IN IT. Without it a signature over "I am buying 5 of listing 3"
 * could be replayed against a DIFFERENT payment — or against none. Binding the
 * claim to the transaction that paid for it is the same rule
 * `bootConfirmMessage` follows.
 */
export function fillMessage(listingId: number, units: number, txid: string): string {
  return `fill:${listingId}:${units}:${txid}`;
}
