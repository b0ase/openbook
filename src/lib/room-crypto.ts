import { ECIES, PrivateKey, PublicKey, SymmetricKey, Utils } from "@bsv/sdk";

/**
 * Encrypting what is said inside a room.
 *
 * ⚠ WHY THIS HAD TO EXIST. A room charges a ticket at the door and then wrote
 * every word of the conversation onto a public chain in plaintext. The owner's
 * verdict on the warning I had written about that — *"a paid room is not a
 * private room"* — was that it *"is stupid"*, and he is right: a gate around
 * content anybody can read straight off the chain is a turnstile in an open
 * field. Either the room is private or the ticket is decoration.
 *
 * ── THE DESIGN, AND THE ONE THING IT TRADES AWAY ─────────────────────────────
 *
 * Each post is encrypted with its OWN random key, and that key is then wrapped
 * separately to every member of the room. There is no long-lived "room key".
 *
 * What that buys:
 *
 *  - **The operator holds nothing.** No key ever reaches the server, so "trust me
 *    with your balances" does not quietly become "trust me with your
 *    conversations". Given the whole point of the room is that it is paid for,
 *    the platform being able to read it would have been the worst possible
 *    default.
 *  - **No distribution race.** A shared room key has to be handed to each new
 *    member by somebody who already has it — which means either the server holds
 *    it (see above) or a new member waits for another member to come online.
 *    Wrapping per post removes the question entirely.
 *  - **Leaving takes nothing with you.** A member who sells up keeps only what
 *    they could already read. With a shared key they would keep the ability to
 *    read everything written afterwards, forever, and no rotation scheme fixes
 *    that on an append-only chain.
 *
 * ⚠ WHAT IT COSTS, STATED PLAINLY: **a new member cannot read what was said
 * before they joined.** Their ticket buys the room from the moment they walk in.
 * That is a real product decision and the alternative — re-wrapping history to
 * every arrival — cannot be done without somebody holding a master key. On a
 * chain that never forgets, "who can read this" is decided once, at write time,
 * and cannot be widened later.
 *
 * ⚠ AND WHAT IT CANNOT DO AT ALL. Any member can decrypt and republish. That is
 * not a flaw to be fixed; it is what read access *means*. Encryption keeps the
 * room shut to people who never paid. It cannot make somebody who paid
 * trustworthy.
 *
 * ⚠ THE CIPHERTEXT IS PERMANENT. It is inscribed and cannot be withdrawn, so a
 * key that leaks in ten years retroactively opens everything it ever wrapped.
 * Do not treat this as a guarantee against a determined future adversary; treat
 * it as what makes a paid room actually private today.
 */

/** Envelope version, so a reader can refuse what it does not understand. */
export const ROOM_ENVELOPE_VERSION = 1;

export interface SealedPost {
  v: number;
  /** AES-256-GCM ciphertext of the plaintext, base64. */
  ct: string;
  /**
   * The per-post key, encrypted once per recipient, keyed by compressed pubkey.
   *
   * ⚠ THE RECIPIENT LIST IS PUBLIC EVEN THOUGH THE CONTENT IS NOT. Membership of
   * a room is already public (it is paid for on chain), so this leaks nothing new
   * — but it does mean the SIZE of a room is visible, and that a post names who
   * could read it. Said here so nobody assumes otherwise.
   */
  keys: Record<string, string>;
}

/** Whether a stored body is a sealed envelope rather than plaintext. */
export function isSealed(body: string): boolean {
  if (!body.startsWith("{")) return false;
  try {
    const p = JSON.parse(body) as Partial<SealedPost>;
    return typeof p.ct === "string" && typeof p.keys === "object" && p.keys !== null;
  } catch {
    return false;
  }
}

/**
 * Encrypt `plaintext` so that exactly `recipientPubkeys` can read it.
 *
 * ⚠ THE AUTHOR MUST BE IN THE LIST OR THEY CANNOT READ THEIR OWN POST. The caller
 * supplies the full membership; this does not add anybody, because silently
 * granting access is precisely the bug that would make the room a lie.
 */
export function sealForRoom(plaintext: string, recipientPubkeys: readonly string[]): SealedPost {
  const unique = [...new Set(recipientPubkeys)].filter(Boolean);
  if (unique.length === 0) {
    throw new Error("sealForRoom: no recipients — an unreadable post is not a private one");
  }

  // A fresh key per post. Reuse across posts would make one compromise open
  // everything, which is the shared-room-key failure in miniature.
  const postKey = SymmetricKey.fromRandom();
  const ct = Utils.toBase64(postKey.encrypt(plaintext, "array") as number[]);

  const keys: Record<string, string> = {};
  const keyBytes = postKey.toArray();
  for (const pk of unique) {
    // ⚠ A BAD PUBKEY MUST NOT SILENTLY DROP A RECIPIENT. Throwing here fails the
    // post; skipping would publish something a paying member cannot open, and
    // they would have no way to tell that from an empty room.
    const pub = PublicKey.fromString(pk);
    // Ephemeral sender key: the wrap must not require the author's private key to
    // undo, or only the author could re-derive it.
    const ephemeral = PrivateKey.fromRandom();
    keys[pk] = Utils.toBase64(ECIES.electrumEncrypt(keyBytes, pub, ephemeral));
  }

  return { v: ROOM_ENVELOPE_VERSION, ct, keys };
}

/**
 * Open a sealed post with one member's private key.
 *
 * Returns null when this key is not a recipient — a normal answer, not an error:
 * it is what every post written before somebody joined looks like to them.
 */
export function openSealed(sealed: SealedPost, wif: string, pubkey: string): string | null {
  if (sealed.v !== ROOM_ENVELOPE_VERSION) return null;
  const wrapped = sealed.keys?.[pubkey];
  if (!wrapped) return null;
  try {
    const priv = PrivateKey.fromWif(wif);
    const keyBytes = ECIES.electrumDecrypt(Utils.toArray(wrapped, "base64"), priv);
    const postKey = new SymmetricKey(keyBytes);
    return postKey.decrypt(Utils.toArray(sealed.ct, "base64"), "utf8") as string;
  } catch {
    // Wrong key, corrupted envelope, truncated ciphertext — all indistinguishable
    // to a reader and all mean the same thing: this is not yours to read.
    return null;
  }
}

/** Parse a stored body into an envelope, or null if it is ordinary plaintext. */
export function parseSealed(body: string): SealedPost | null {
  if (!isSealed(body)) return null;
  try {
    return JSON.parse(body) as SealedPost;
  } catch {
    return null;
  }
}
