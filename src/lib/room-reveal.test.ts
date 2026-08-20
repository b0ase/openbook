/**
 * What a reader sees.
 *
 * ⚠ THE FAILURE TO AVOID IS A ROOM THAT LOOKS EMPTY. A post somebody cannot
 * open is not an error and not a blank — it is the permanent, expected view of
 * anything said before they joined. Rendering it as nothing sends people
 * looking for a bug that is not there.
 */

import { PrivateKey } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { sealForRoom } from "./room-crypto";
import { revealContent } from "./room-reveal";

function key() {
  const k = PrivateKey.fromRandom();
  return { wif: k.toWif(), pubkey: k.toPublicKey().toString() };
}

describe("revealContent", () => {
  it("passes an ordinary post through untouched", () => {
    expect(revealContent("a thought about $Occam", null, null)).toEqual({
      text: "a thought about $Occam",
      state: "plain",
    });
  });

  it("opens a post sealed to this reader", () => {
    const a = key();
    const body = JSON.stringify(sealForRoom("the room's business", [a.pubkey]));
    expect(revealContent(body, a.wif, a.pubkey)).toEqual({
      text: "the room's business",
      state: "opened",
    });
  });

  it("locks a post sealed to somebody else — the join-date case", () => {
    const founder = key();
    const joiner = key();
    const body = JSON.stringify(sealForRoom("said before you arrived", [founder.pubkey]));
    expect(revealContent(body, joiner.wif, joiner.pubkey)).toEqual({ text: "", state: "locked" });
  });

  it("NEVER returns the envelope as text", () => {
    // ⚠ Leaking ciphertext into the feed as though it were a message is worse
    // than saying nothing — it looks like corruption and it is unreadable.
    const founder = key();
    const outsider = key();
    const body = JSON.stringify(sealForRoom("secret", [founder.pubkey]));
    const r = revealContent(body, outsider.wif, outsider.pubkey);
    expect(r.text).toBe("");
    expect(r.text).not.toContain("ct");
  });

  it("treats a signed-out reader as simply not a recipient", () => {
    const a = key();
    const body = JSON.stringify(sealForRoom("members only", [a.pubkey]));
    expect(revealContent(body, null, null).state).toBe("locked");
    expect(revealContent(body, a.wif, null).state).toBe("locked");
    expect(revealContent(body, null, a.pubkey).state).toBe("locked");
  });

  it("does not throw on a corrupted envelope", () => {
    const a = key();
    const sealed = sealForRoom("x", [a.pubkey]);
    const broken = JSON.stringify({ ...sealed, ct: "not-base64-at-all!!" });
    expect(() => revealContent(broken, a.wif, a.pubkey)).not.toThrow();
    expect(revealContent(broken, a.wif, a.pubkey).state).toBe("locked");
  });

  it("does not mistake an ordinary JSON post for an envelope", () => {
    // Somebody pasting JSON into the box must not render as a locked room post.
    expect(revealContent('{"hello":"world"}', null, null).state).toBe("plain");
  });
});
