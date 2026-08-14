/**
 * The inscription envelope.
 *
 * These prove the script is SHAPED right and, more importantly, that the
 * inscription cannot affect spendability — the lock has to stay an ordinary
 * P2PKH or the author cannot move their own post. They do NOT prove any
 * indexer recognises the result; only a broadcast can show that.
 */

import { OP, P2PKH, Script, Utils } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import {
  buildInscriptionScript,
  hasInscription,
  INSCRIPTION_SATS,
  parseInscription,
} from "./inscription";

const ADDRESS = "1Bnds27YrqjmfuVkkJixmzukfJPrrsMMni";
const json = (o: unknown) => Utils.toArray(JSON.stringify(o), "utf8");

describe("buildInscriptionScript", () => {
  it("carries exactly one satoshi — that is what makes it an ordinal", () => {
    expect(INSCRIPTION_SATS).toBe(1);
  });

  it("STARTS with an ordinary P2PKH lock, byte for byte", () => {
    // The load-bearing assertion. If the lock is not a plain P2PKH the author
    // cannot spend their own inscription, and "you own what you post" is false.
    const plain = new P2PKH().lock(ADDRESS);
    const inscribed = buildInscriptionScript({
      address: ADDRESS,
      contentType: "application/json",
      data: json({ hello: "world" }),
    });

    const prefix = inscribed.toHex().slice(0, plain.toHex().length);
    expect(prefix).toBe(plain.toHex());
  });

  it("appends the envelope AFTER OP_CHECKSIG, so it never executes", () => {
    const inscribed = buildInscriptionScript({
      address: ADDRESS,
      contentType: "text/plain",
      data: Utils.toArray("hi", "utf8"),
    });
    const ops = inscribed.chunks.map((c) => c.op);
    const checksig = ops.indexOf(OP.OP_CHECKSIG);
    const envelope = ops.indexOf(OP.OP_IF);

    expect(checksig).toBeGreaterThan(-1);
    expect(envelope).toBeGreaterThan(checksig);
    expect(ops[ops.length - 1]).toBe(OP.OP_ENDIF);
  });

  it("round-trips content type and payload through serialization", () => {
    const payload = json({ app: "openbooks", type: "post", id: 42 });
    const script = buildInscriptionScript({
      address: ADDRESS,
      contentType: "application/json",
      data: payload,
    });

    // Parse from hex, not from the object we just built — the chain hands us
    // bytes, so that is the path that has to work.
    const parsed = parseInscription(Script.fromHex(script.toHex()));
    expect(parsed).not.toBeNull();
    expect(parsed?.contentType).toBe("application/json");
    expect(Utils.toUTF8(parsed?.data ?? [])).toBe(
      JSON.stringify({ app: "openbooks", type: "post", id: 42 })
    );
  });

  it("handles a payload with multi-byte characters", () => {
    const text = "señor — 🥾 boost";
    const script = buildInscriptionScript({
      address: ADDRESS,
      contentType: "text/plain;charset=utf-8",
      data: Utils.toArray(text, "utf8"),
    });
    const parsed = parseInscription(Script.fromHex(script.toHex()));
    expect(Utils.toUTF8(parsed?.data ?? [])).toBe(text);
  });

  it("refuses to build without an owner or a content type", () => {
    // A missing owner would silently produce an unspendable or wrongly-owned
    // token — fail loudly instead.
    expect(() =>
      buildInscriptionScript({ address: "", contentType: "text/plain", data: [] })
    ).toThrow();
    expect(() => buildInscriptionScript({ address: ADDRESS, contentType: "", data: [] })).toThrow();
  });
});

describe("hasInscription", () => {
  it("is true for an inscribed lock and false for a plain one", () => {
    expect(hasInscription(new P2PKH().lock(ADDRESS))).toBe(false);
    expect(
      hasInscription(
        buildInscriptionScript({ address: ADDRESS, contentType: "text/plain", data: [] })
      )
    ).toBe(true);
  });

  it("does NOT match a payload that merely contains the marker bytes", () => {
    // Structural detection, not a hex substring search: `ord` occurs in plenty
    // of ordinary text, and a substring check would call an anchored post an
    // inscription.
    const script = new Script();
    script.writeOpCode(OP.OP_FALSE);
    script.writeOpCode(OP.OP_RETURN);
    script.writeBin(Utils.toArray('{"content":"a word about ord"}', "utf8"));

    expect(hasInscription(script)).toBe(false);
    expect(parseInscription(script)).toBeNull();
  });
});

describe("parseInscription", () => {
  it("returns null for malformed bytes rather than throwing", () => {
    // This parses attacker-supplied data off the chain; wrong shape is an
    // expected input, not an exception.
    const truncated = new Script();
    truncated.writeOpCode(OP.OP_FALSE);
    truncated.writeOpCode(OP.OP_IF);
    truncated.writeBin(Utils.toArray("ord", "utf8"));

    expect(parseInscription(truncated)).toBeNull();
    expect(parseInscription(new Script())).toBeNull();
    expect(parseInscription(new P2PKH().lock(ADDRESS))).toBeNull();
  });

  it("treats an empty payload as empty, not as absent", () => {
    const script = buildInscriptionScript({
      address: ADDRESS,
      contentType: "application/json",
      data: [],
    });
    const parsed = parseInscription(Script.fromHex(script.toHex()));
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toEqual([]);
  });
});
