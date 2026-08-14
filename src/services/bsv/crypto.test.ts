/**
 * AES-256-GCM WIF encryption.
 *
 * This module is the whole of the passphrase system: it is what stands between
 * a stolen `bfn_keypair_enc` localStorage value and someone's private key. It
 * had no direct test.
 *
 * The properties asserted here are the ones whose absence would be silent —
 * encryption that "works" (round-trips fine) while reusing an IV, or accepting
 * tampered ciphertext, looks completely normal from the outside.
 */

import { describe, expect, it } from "vitest";
import { decryptWif, encryptWif, isEncrypted } from "./crypto";

// A structurally realistic WIF (never used, never funded).
const WIF = "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ";
const PASS = "correct horse battery staple";

describe("encryptWif / decryptWif", () => {
  it("round-trips", async () => {
    const enc = await encryptWif(WIF, PASS);
    expect(await decryptWif(enc, PASS)).toBe(WIF);
  });

  it("returns null for the wrong passphrase — never throws", async () => {
    // Callers branch on null. A throw here would surface as a crash mid-unlock.
    const enc = await encryptWif(WIF, PASS);
    expect(await decryptWif(enc, "wrong passphrase")).toBeNull();
    expect(await decryptWif(enc, "")).toBeNull();
    expect(await decryptWif(enc, `${PASS} `)).toBeNull(); // trailing space matters
  });

  it("produces the enc: prefix", async () => {
    const enc = await encryptWif(WIF, PASS);
    expect(enc.startsWith("enc:")).toBe(true);
    expect(isEncrypted(enc)).toBe(true);
  });

  it("NEVER produces the same ciphertext twice for the same input", async () => {
    // ⚠ THE ONE THAT MATTERS MOST. AES-GCM catastrophically loses
    // confidentiality if an IV is reused under the same key: an attacker with
    // two messages under one (key, IV) can recover their XOR and forge tags.
    // A fresh random salt AND IV per call is what prevents it — and identical
    // output would still round-trip perfectly, so nothing else would notice.
    const a = await encryptWif(WIF, PASS);
    const b = await encryptWif(WIF, PASS);
    expect(a).not.toBe(b);

    // Both still decrypt — different envelope, same plaintext.
    expect(await decryptWif(a, PASS)).toBe(WIF);
    expect(await decryptWif(b, PASS)).toBe(WIF);
  });

  it("uses a distinct salt and IV on every call", async () => {
    // Stronger than the pairwise check: 25 encryptions, 25 distinct 28-byte
    // salt+IV prefixes. A fixed or counter-based IV would collide here.
    const prefixes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const enc = await encryptWif(WIF, PASS);
      const raw = Uint8Array.from(atob(enc.slice(4)), (c) => c.charCodeAt(0));
      prefixes.add(Array.from(raw.slice(0, 28)).join(","));
    }
    expect(prefixes.size).toBe(25);
  });

  it("REJECTS tampered ciphertext — the GCM tag is doing its job", async () => {
    // Authentication is the reason for GCM over CBC. Without it, an attacker
    // who can write to localStorage could flip bits and the user would decrypt
    // to a corrupted key — and silently lose funds sent to a wrong address.
    const enc = await encryptWif(WIF, PASS);
    const raw = Uint8Array.from(atob(enc.slice(4)), (c) => c.charCodeAt(0));

    // Flip one bit deep in the ciphertext, past salt+IV.
    raw[40] ^= 0x01;
    const tampered = `enc:${btoa(String.fromCharCode(...raw))}`;

    expect(await decryptWif(tampered, PASS)).toBeNull();
  });

  it("rejects a tampered salt or IV", async () => {
    const enc = await encryptWif(WIF, PASS);
    const raw = Uint8Array.from(atob(enc.slice(4)), (c) => c.charCodeAt(0));

    const saltFlipped = Uint8Array.from(raw);
    saltFlipped[0] ^= 0xff; // wrong salt → wrong derived key
    expect(await decryptWif(`enc:${btoa(String.fromCharCode(...saltFlipped))}`, PASS)).toBeNull();

    const ivFlipped = Uint8Array.from(raw);
    ivFlipped[20] ^= 0xff; // inside the IV → tag mismatch
    expect(await decryptWif(`enc:${btoa(String.fromCharCode(...ivFlipped))}`, PASS)).toBeNull();
  });
});

describe("decryptWif — malformed input never throws", () => {
  // Anything reachable from a user-supplied recovery file lands here.
  it.each([
    ["", "empty"],
    ["not encrypted at all", "no prefix"],
    ["enc:", "prefix only"],
    ["enc:!!!not base64!!!", "invalid base64"],
    ["enc:aGVsbG8=", "valid base64, far too short for salt+iv"],
    ["enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "all zeros"],
  ])("returns null for %j (%s)", async (input) => {
    await expect(decryptWif(input, PASS)).resolves.toBeNull();
  });
});

describe("isEncrypted", () => {
  it("distinguishes encrypted from plaintext storage", async () => {
    // getIdentity branches on this to decide whether a passphrase is needed.
    // A false negative on a real encrypted value would look like a lost key.
    expect(isEncrypted(await encryptWif(WIF, PASS))).toBe(true);
    expect(isEncrypted(WIF)).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });
});

describe("passphrase handling", () => {
  it("handles unicode and long passphrases", async () => {
    for (const pass of ["🔐 パスフレーズ ✓", "x".repeat(500), "  spaces  matter  "]) {
      const enc = await encryptWif(WIF, pass);
      expect(await decryptWif(enc, pass)).toBe(WIF);
    }
  });

  it("is case sensitive", async () => {
    const enc = await encryptWif(WIF, "MyPassphrase");
    expect(await decryptWif(enc, "mypassphrase")).toBeNull();
  });
});
