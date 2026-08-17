/**
 * The exact string somebody signs to burn a ticket and enter a room.
 *
 * ⚠ ONE SOURCE, BYTE FOR BYTE, for the reason `boot-message.ts` and
 * `listing-message.ts` exist: the client signs and the server verifies, and a
 * signature over a string that differs by a separator is simply invalid. Two
 * literals in two files is a bug that shows up only in production, on the money
 * path, as "it just doesn't work".
 *
 * ⚠ THE SYMBOL IS IN IT, AND HAS TO BE. Entry DESTROYS a unit, so a signature
 * over a bare "let me in" would authorise burning a ticket to any room — the
 * cheap one the holder meant, or the expensive one they did not. Naming the room
 * is what makes the authorisation specific to the thing being spent.
 */
export function enterRoomMessage(symbol: string): string {
  return `enter-room:${symbol}`;
}
