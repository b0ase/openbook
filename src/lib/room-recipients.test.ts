/**
 * Who can read a room.
 *
 * ⚠ THE FAILURES HERE ARE PERMANENT ONES. A post's recipient list is fixed at
 * the moment it is inscribed and cannot be widened afterwards — so sealing to
 * the wrong set does not produce an error, it produces a room that is
 * permanently unreadable by someone who should be able to read it. That
 * includes the platform, whose whole purpose here is to be able to moderate
 * what the board serves.
 */

import { PrivateKey } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { openSealed, sealForRoom } from "./room-crypto";
import { isPlatformReadable, roomRecipients } from "./room-recipients";

function key() {
  const k = PrivateKey.fromRandom();
  return { wif: k.toWif(), pubkey: k.toPublicKey().toString() };
}

const PLATFORM = key();

describe("roomRecipients", () => {
  it("adds the platform to every room", () => {
    const a = key();
    const r = roomRecipients([a.pubkey], PLATFORM.pubkey);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pubkeys).toContain(PLATFORM.pubkey);
  });

  it("REFUSES rather than sealing a room the platform cannot read", () => {
    // ⚠ The important one. Sealing to members alone would succeed, look
    // correct, and permanently create the unmoderatable room this design exists
    // to prevent — with nothing appearing wrong until something was.
    const a = key();
    expect(roomRecipients([a.pubkey], "")).toEqual({ ok: false, reason: "no_platform_key" });
    expect(roomRecipients([a.pubkey], "   ")).toEqual({ ok: false, reason: "no_platform_key" });
  });

  it("REFUSES a malformed platform key instead of failing later", () => {
    // A typo would otherwise throw inside sealForRoom, mid-post, and read as an
    // encryption bug rather than a configuration one.
    const a = key();
    expect(roomRecipients([a.pubkey], "not-a-pubkey")).toEqual({
      ok: false,
      reason: "bad_platform_key",
    });
  });

  it("refuses a room with no members", () => {
    expect(roomRecipients([], PLATFORM.pubkey)).toEqual({ ok: false, reason: "no_members" });
  });

  it("does not add anybody except the platform", () => {
    // Silently granting read access is the bug that makes a ticket a lie.
    const a = key();
    const b = key();
    const r = roomRecipients([a.pubkey, b.pubkey], PLATFORM.pubkey);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pubkeys.sort()).toEqual([a.pubkey, b.pubkey, PLATFORM.pubkey].sort());
  });

  it("does not double-wrap when the platform is also a member", () => {
    const r = roomRecipients([PLATFORM.pubkey], PLATFORM.pubkey);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pubkeys).toEqual([PLATFORM.pubkey]);
  });
});

describe("end to end: the platform can actually read what it is sent", () => {
  it("decrypts a room post with its own key, and outsiders still cannot", () => {
    // The property the whole design rests on. Being NAMED as a recipient is not
    // the same as being able to open it — this proves the key works.
    const member = key();
    const outsider = key();
    const r = roomRecipients([member.pubkey], PLATFORM.pubkey);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const sealed = sealForRoom("what was said in the room", r.pubkeys);

    expect(openSealed(sealed, member.wif, member.pubkey)).toBe("what was said in the room");
    expect(openSealed(sealed, PLATFORM.wif, PLATFORM.pubkey)).toBe("what was said in the room");
    expect(openSealed(sealed, outsider.wif, outsider.pubkey)).toBeNull();
  });
});

describe("isPlatformReadable", () => {
  it("audits an existing post rather than assuming", () => {
    const a = key();
    expect(isPlatformReadable([a.pubkey, PLATFORM.pubkey], PLATFORM.pubkey)).toBe(true);
    expect(isPlatformReadable([a.pubkey], PLATFORM.pubkey)).toBe(false);
    // No configured key means nothing can be asserted as readable.
    expect(isPlatformReadable([a.pubkey], "")).toBe(false);
  });
});
