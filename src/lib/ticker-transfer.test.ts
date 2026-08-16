import { describe, expect, it } from "vitest";
import {
  isValidRecipientPubkey,
  tickerTransferAnnouncement,
  validateTransfer,
} from "./ticker-transfer";

const A = "026ba10b1c3a01eb12338f767f80ccb7a1e67bf301d9285f6569c67ea52d1b125b";
const B = "03d0d892582c01d31eac7500fc1d32f3d26becfa8a3dd50fd6b33f9f0e2908ad12";

describe("isValidRecipientPubkey", () => {
  it("accepts a compressed secp256k1 key in either prefix", () => {
    expect(isValidRecipientPubkey(A)).toBe(true);
    expect(isValidRecipientPubkey(B)).toBe(true);
  });

  it("rejects anything that is not one", () => {
    for (const bad of [
      "", // empty
      "19j9p7Y8kmvmdAvkNfbLaygKAu3igr2mCH", // an ADDRESS, the easy mistake
      `04${"a".repeat(126)}`, // uncompressed
      A.slice(0, 64), // truncated
      `${A}ff`, // too long
      `02${"z".repeat(64)}`, // not hex
      null,
      undefined,
      7,
      {},
    ]) {
      expect(isValidRecipientPubkey(bad)).toBe(false);
    }
  });
});

describe("tickerTransferAnnouncement — the signed message", () => {
  it("binds BOTH the symbol and the recipient", () => {
    // Symbol alone → a captured signature could be redirected to anyone.
    // Recipient alone → one signature would move every ticker the owner holds.
    const m = tickerTransferAnnouncement("CHESTERTON", A);
    expect(m).toContain("CHESTERTON");
    expect(m).toContain(A);
  });

  it("canonicalises the symbol so one transfer has one signature", () => {
    const canonical = tickerTransferAnnouncement("CHESTERTON", A);
    expect(tickerTransferAnnouncement("chesterton", A)).toBe(canonical);
    expect(tickerTransferAnnouncement("Chesterton", A)).toBe(canonical);
  });

  it("normalises recipient key casing too", () => {
    expect(tickerTransferAnnouncement("X", A.toUpperCase())).toBe(
      tickerTransferAnnouncement("X", A)
    );
  });

  it("differs for a different recipient, and for a different symbol", () => {
    expect(tickerTransferAnnouncement("X", A)).not.toBe(tickerTransferAnnouncement("X", B));
    expect(tickerTransferAnnouncement("X", A)).not.toBe(tickerTransferAnnouncement("Y", A));
  });

  it("reads as a sentence, because it is what the board will show forever", () => {
    expect(tickerTransferAnnouncement("chesterton", A)).toBe(`Transferring $CHESTERTON to ${A}`);
  });
});

describe("validateTransfer", () => {
  it("accepts a well-formed transfer", () => {
    expect(validateTransfer("CHESTERTON", A, B)).toEqual({ ok: true });
  });

  it("rejects a recipient that is an address rather than a key", () => {
    expect(validateTransfer("X", "19j9p7Y8kmvmdAvkNfbLaygKAu3igr2mCH", B)).toEqual({
      ok: false,
      reason: "invalid_recipient",
    });
  });

  it("rejects sending a name to its current holder", () => {
    // A no-op that would still charge the user for a post.
    expect(validateTransfer("X", A, A)).toEqual({ ok: false, reason: "same_owner" });
    expect(validateTransfer("X", A.toUpperCase(), A)).toEqual({ ok: false, reason: "same_owner" });
  });

  it("rejects a symbol that could never have been claimed", () => {
    for (const bad of ["", "$", "1ABC", "way-too-long-to-be-a-ticker-symbol"]) {
      expect(validateTransfer(bad, A, B).ok).toBe(false);
    }
  });
});
