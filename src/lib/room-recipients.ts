/**
 * Who a room's post is encrypted to — and the one rule that must not be
 * forgotten in any code path.
 *
 * ⚠ THE PLATFORM IS ALWAYS A RECIPIENT, BY THE OWNER'S DECISION (2026-08-20).
 * A room is encrypted so that people who did not buy a ticket cannot read it.
 * It is NOT encrypted against the operator, who holds a key to every room in
 * order to moderate the board.
 *
 * The reasoning, in his words: *"even if people put illegal shit on the chain,
 * as long as we censor it and aren't serving it through openbooks.space there's
 * nothing to answer."* That is the correct division of responsibility. What is
 * inscribed on Bitcoin was never the operator's to remove — the author's own
 * browser broadcasts it — and a platform's actual obligation is to stop serving
 * what it hosts once it knows. This key is what makes acting on that possible.
 *
 * ⚠ SO "PRIVATE ROOM" MUST NOT BE SAID WITHOUT SAYING THIS. A room the operator
 * can read is private from other USERS, not from the platform. Selling a ticket
 * on the stronger implication would be a false claim about the product. The UI
 * that creates or joins a room has to state it.
 *
 * ⚠ THE PRIVATE HALF OF THIS KEY MUST NOT LIVE ON THE SERVER. Only the PUBLIC
 * key is needed to seal, and public keys are public — so the deployment needs
 * nothing secret. Keeping the private key on the operator's own machine means a
 * server compromise does not hand over every private conversation on the
 * platform. Decryption is an offline act, performed deliberately, with
 * `scripts/read-room.mjs`.
 */

import { PublicKey } from "@bsv/sdk";

/**
 * The platform's room-reading public key.
 *
 * `NEXT_PUBLIC_` because the SEAL happens in the author's browser, which
 * therefore needs this value. That is safe and is the whole point of it being a
 * public key.
 */
export const PLATFORM_ROOM_PUBKEY = process.env.NEXT_PUBLIC_PLATFORM_ROOM_PUBKEY ?? "";

export type RecipientResult =
  | { ok: true; pubkeys: string[] }
  | { ok: false; reason: "no_platform_key" | "bad_platform_key" | "no_members" };

/**
 * The full recipient list for a room post: every member, plus the platform.
 *
 * ⚠ FAILS CLOSED, AND THE DIRECTION IS DELIBERATE. If the platform key is
 * missing or malformed this REFUSES rather than sealing to members alone.
 * Sealing without it would silently create a room whose contents the operator
 * can never read — permanently, because the recipient list of an inscribed post
 * cannot be widened afterwards. A misconfigured deploy would quietly
 * manufacture exactly the unmoderatable rooms this design exists to prevent,
 * and nothing would look wrong until something was.
 *
 * ⚠ THE AUTHOR MUST ALREADY BE IN `memberPubkeys`. This does not add them:
 * silently granting read access is the bug that would make the ticket a lie,
 * and an author who has not entered the room has not paid to be in it.
 */
export function roomRecipients(
  memberPubkeys: readonly string[],
  platformPubkey: string = PLATFORM_ROOM_PUBKEY
): RecipientResult {
  const members = [...new Set(memberPubkeys)].filter(Boolean);
  if (members.length === 0) return { ok: false, reason: "no_members" };

  const platform = platformPubkey.trim();
  if (!platform) return { ok: false, reason: "no_platform_key" };
  try {
    // Parsed, not merely non-empty. A typo'd key would throw later inside
    // `sealForRoom` — after the author had begun posting — and the failure
    // would read as an encryption bug rather than a configuration one.
    PublicKey.fromString(platform);
  } catch {
    return { ok: false, reason: "bad_platform_key" };
  }

  // De-duplicated so the platform being a member in its own right (it can hold
  // a ticket like anyone) does not produce two identical wrapped keys.
  return { ok: true, pubkeys: [...new Set([...members, platform])] };
}

/** Whether a sealed post can be read by the platform — an audit, not a guess. */
export function isPlatformReadable(
  recipientPubkeys: readonly string[],
  platformPubkey: string = PLATFORM_ROOM_PUBKEY
): boolean {
  const platform = platformPubkey.trim();
  return Boolean(platform) && recipientPubkeys.includes(platform);
}
