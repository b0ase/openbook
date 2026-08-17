/**
 * Encrypted rooms.
 *
 * ⚠ WHAT THESE ARE GUARDING. A room charged a ticket and then published the
 * conversation in plaintext on a public chain — the ticket bought participation
 * and nothing else. The failures that matter here are not "it threw"; they are
 * the ones where it appears to work and somebody who never paid can read, or
 * somebody who did pay cannot.
 */

import { PrivateKey } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { isSealed, openSealed, parseSealed, sealForRoom } from "./room-crypto";

function member() {
  const key = PrivateKey.fromRandom();
  return { wif: key.toWif(), pubkey: key.toPublicKey().toString() };
}

describe("sealForRoom / openSealed", () => {
  it("lets every named member read it", () => {
    const a = member();
    const b = member();
    const sealed = sealForRoom("the room's business", [a.pubkey, b.pubkey]);

    expect(openSealed(sealed, a.wif, a.pubkey)).toBe("the room's business");
    expect(openSealed(sealed, b.wif, b.pubkey)).toBe("the room's business");
  });

  it("REFUSES somebody who was not named", () => {
    // ⚠ The whole point. An outsider reading the chain gets ciphertext.
    const a = member();
    const outsider = member();
    const sealed = sealForRoom("members only", [a.pubkey]);

    expect(openSealed(sealed, outsider.wif, outsider.pubkey)).toBeNull();
  });

  it("REFUSES an outsider even if they claim a member's pubkey", () => {
    // Membership is public, so guessing the right pubkey is trivial — it must be
    // the KEY that opens it, never the name of the key.
    const a = member();
    const outsider = member();
    const sealed = sealForRoom("members only", [a.pubkey]);

    expect(openSealed(sealed, outsider.wif, a.pubkey)).toBeNull();
  });

  it("puts no plaintext in the envelope", () => {
    // A leak here would make every other test meaningless.
    const a = member();
    const secret = "the treasury address is xyzzy";
    const sealed = sealForRoom(secret, [a.pubkey]);
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(JSON.stringify(sealed)).not.toContain("treasury");
  });

  it("uses a DIFFERENT key for every post", () => {
    // Reuse would mean one compromise opens the whole room's history.
    const a = member();
    const one = sealForRoom("same words", [a.pubkey]);
    const two = sealForRoom("same words", [a.pubkey]);
    expect(one.ct).not.toBe(two.ct);
    expect(one.keys[a.pubkey]).not.toBe(two.keys[a.pubkey]);
  });

  it("survives a round trip through storage", () => {
    const a = member();
    const sealed = sealForRoom("written, stored, read back", [a.pubkey]);
    const body = JSON.stringify(sealed);
    const parsed = parseSealed(body);
    expect(parsed).not.toBeNull();
    if (parsed) expect(openSealed(parsed, a.wif, a.pubkey)).toBe("written, stored, read back");
  });

  it("handles unicode and long content", () => {
    const a = member();
    const text = `${"— naïve café 🔒 ".repeat(50)}end`;
    const sealed = sealForRoom(text, [a.pubkey]);
    expect(openSealed(sealed, a.wif, a.pubkey)).toBe(text);
  });

  it("REFUSES to seal to nobody", () => {
    // An unreadable post is not a private one — it is a lost one, and it would be
    // paid for and permanent.
    expect(() => sealForRoom("x", [])).toThrow();
  });

  it("throws on a malformed recipient rather than dropping them", () => {
    // ⚠ Skipping a bad key would publish something a paying member cannot open,
    // and an empty room is indistinguishable from a room they were shut out of.
    const a = member();
    expect(() => sealForRoom("x", [a.pubkey, "not-a-pubkey"])).toThrow();
  });

  it("does not grow the recipient list on its own", () => {
    const a = member();
    const b = member();
    const sealed = sealForRoom("x", [a.pubkey, a.pubkey, b.pubkey]);
    expect(Object.keys(sealed.keys).sort()).toEqual([a.pubkey, b.pubkey].sort());
  });
});

describe("isSealed", () => {
  it("recognises an envelope and leaves ordinary posts alone", () => {
    const a = member();
    expect(isSealed(JSON.stringify(sealForRoom("x", [a.pubkey])))).toBe(true);
    expect(isSealed("an ordinary post about $Occam")).toBe(false);
    expect(isSealed("")).toBe(false);
    // A post that merely happens to be JSON is not an envelope.
    expect(isSealed('{"hello":"world"}')).toBe(false);
    expect(isSealed("{not json")).toBe(false);
  });
});

describe("what a new member sees", () => {
  it("cannot read what was written before they joined — the stated trade", () => {
    // ⚠ NOT A BUG. Deciding who can read happens once, at write time, on a chain
    // that cannot be rewritten. Widening it later would need somebody to hold a
    // master key, which is exactly what this design refuses.
    const founder = member();
    const before = sealForRoom("said before you arrived", [founder.pubkey]);

    const joiner = member();
    const after = sealForRoom("said after you arrived", [founder.pubkey, joiner.pubkey]);

    expect(openSealed(before, joiner.wif, joiner.pubkey)).toBeNull();
    expect(openSealed(after, joiner.wif, joiner.pubkey)).toBe("said after you arrived");
  });
});
