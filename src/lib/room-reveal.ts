import { openSealed, parseSealed } from "./room-crypto";

/**
 * Turning a stored body into something to render.
 *
 * ⚠ THREE STATES, AND THE THIRD IS THE ONE THAT NEEDS SAYING OUT LOUD. A post
 * is plaintext, or it is sealed and this reader can open it, or it is sealed
 * and they cannot. That last case is NOT an error and NOT an empty post — it is
 * the normal, permanent experience of anybody who joined a room after something
 * was said in it.
 *
 * ⚠ WHY IT CAN NEVER BE FIXED. A post's recipients are chosen once, at the
 * moment it is inscribed, on a chain that cannot be rewritten. Widening that
 * list later would require somebody to hold a master key over every room, which
 * is the thing the design refuses. So a new member's ticket buys them the room
 * from the moment they walk in, and not one word before it.
 *
 * That is a real product decision with a real cost, and the UI has to state it.
 * Rendering a locked post as blank, or as "failed to load", would send people
 * looking for a bug and leave them believing the room was empty.
 */

export type RevealState =
  /** An ordinary, unencrypted post. */
  | "plain"
  /** Sealed, and this key opened it. */
  | "opened"
  /** Sealed to somebody else — almost always: said before this reader joined. */
  | "locked";

export interface Revealed {
  text: string;
  state: RevealState;
}

/**
 * What this reader should see for a stored body.
 *
 * ⚠ NEVER THROWS, AND NEVER RETURNS CIPHERTEXT AS TEXT. A wrong key, a
 * truncated envelope and a post from before somebody joined are
 * indistinguishable to a reader and all mean the same thing — this is not yours
 * to read. Leaking the raw envelope into the feed as though it were a message
 * would be worse than saying nothing.
 */
export function revealContent(
  content: string,
  wif: string | null,
  pubkey: string | null
): Revealed {
  const sealed = parseSealed(content);
  if (!sealed) return { text: content, state: "plain" };

  // A signed-out reader is simply not a recipient. Same answer, no special case.
  if (!wif || !pubkey) return { text: "", state: "locked" };

  const text = openSealed(sealed, wif, pubkey);
  return text === null ? { text: "", state: "locked" } : { text, state: "opened" };
}

/**
 * Whether this reader could open the post — for callers that only need the
 * question answered, without decrypting twice to find out.
 */
export function canReveal(content: string, wif: string | null, pubkey: string | null): boolean {
  return revealContent(content, wif, pubkey).state !== "locked";
}
