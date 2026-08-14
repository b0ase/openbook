/**
 * AES-256-GCM WIF encryption.
 *
 * This module is the whole of the passphrase system: it is what stands between
 * a stolen `bfn_keypair_enc` value and someone's private key.
 *
 * Two things are being protected here. The obvious one is that encryption works.
 * The load-bearing one is that RAISING THE KDF COST DID NOT ORPHAN EXISTING KEYS —
 * V1 blobs hardcoded 100k iterations, so a naive raise would have made every
 * already-encrypted identity fail to decrypt, indistinguishably from a wrong
 * passphrase. The legacy cases below are the regression test for that.
 */

import { describe, expect, it } from "vitest";
import { decryptWif, encryptWif, isEncrypted, upgradeNeeded } from "./crypto";

// A structurally realistic WIF (never used, never funded).
const WIF = "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ";
const PASS = "correct horse battery staple";

/** Byte offsets in the V2 envelope: version(1) + iterations(4) + salt(16) + iv(12). */
const V2_HEADER = 5;
const SALT_START = V2_HEADER;
const IV_START = V2_HEADER + 16;
const CT_START = V2_HEADER + 16 + 12;

function bytesOf(encoded: string): Uint8Array {
  const body = encoded.slice(encoded.indexOf(":") + 1);
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function reassemble(prefix: string, raw: Uint8Array): string {
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return prefix + btoa(s);
}

/**
 * Build a V1 ("enc:") blob exactly as the old code did — 100k iterations, no
 * header. Written out by hand because the production encoder can no longer
 * produce this format, and without a real one the compatibility claim is
 * untested.
 */
async function legacyEncrypt(wif: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(wif)
  );
  const combined = new Uint8Array(16 + 12 + ct.byteLength);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(new Uint8Array(ct), 28);
  return reassemble("enc:", combined);
}

describe("encryptWif / decryptWif", () => {
  it("round-trips", async () => {
    const enc = await encryptWif(WIF, PASS);
    expect(await decryptWif(enc, PASS)).toBe(WIF);
  });

  it("writes the V2 envelope", async () => {
    const enc = await encryptWif(WIF, PASS);
    expect(enc.startsWith("enc2:")).toBe(true);
    expect(isEncrypted(enc)).toBe(true);
  });

  it("records the iteration count it used", async () => {
    // The entire point of V2. Without this the cost can never be changed again.
    const raw = bytesOf(await encryptWif(WIF, PASS));
    expect(raw[0]).toBe(2); // version
    const iterations = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1, false);
    expect(iterations).toBe(600_000);
  });

  it("returns null for the wrong passphrase — never throws", async () => {
    const enc = await encryptWif(WIF, PASS);
    expect(await decryptWif(enc, "wrong passphrase")).toBeNull();
    expect(await decryptWif(enc, "")).toBeNull();
    expect(await decryptWif(enc, `${PASS} `)).toBeNull();
  });

  it("NEVER produces the same ciphertext twice for the same input", async () => {
    // ⚠ AES-GCM loses confidentiality catastrophically if an IV repeats under one
    // key. Identical output would still round-trip perfectly, so nothing else
    // would ever notice.
    const a = await encryptWif(WIF, PASS);
    const b = await encryptWif(WIF, PASS);
    expect(a).not.toBe(b);
    expect(await decryptWif(a, PASS)).toBe(WIF);
    expect(await decryptWif(b, PASS)).toBe(WIF);
  });

  it("uses a distinct salt and IV on every call", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const raw = bytesOf(await encryptWif(WIF, PASS));
      seen.add(Array.from(raw.slice(SALT_START, CT_START)).join(","));
    }
    expect(seen.size).toBe(15);
  });

  it("REJECTS tampered ciphertext — the GCM tag is doing its job", async () => {
    // Authentication is why GCM and not CBC. Without it, anyone who can write to
    // localStorage could flip bits and the user would decrypt to a corrupted key.
    const raw = bytesOf(await encryptWif(WIF, PASS));
    raw[CT_START + 2] ^= 0x01;
    expect(await decryptWif(reassemble("enc2:", raw), PASS)).toBeNull();
  });

  it("rejects a tampered salt, IV, or iteration count", async () => {
    const base = bytesOf(await encryptWif(WIF, PASS));

    const salt = Uint8Array.from(base);
    salt[SALT_START] ^= 0xff; // different salt → different derived key
    expect(await decryptWif(reassemble("enc2:", salt), PASS)).toBeNull();

    const iv = Uint8Array.from(base);
    iv[IV_START] ^= 0xff;
    expect(await decryptWif(reassemble("enc2:", iv), PASS)).toBeNull();

    const iters = Uint8Array.from(base);
    new DataView(iters.buffer).setUint32(1, 200_000, false); // claim a different cost
    expect(await decryptWif(reassemble("enc2:", iters), PASS)).toBeNull();
  });

  it("refuses an absurd iteration count instead of hanging", async () => {
    // A crafted envelope claiming 4 billion iterations would otherwise lock the
    // browser's main thread inside PBKDF2.
    const raw = bytesOf(await encryptWif(WIF, PASS));
    new DataView(raw.buffer).setUint32(1, 4_000_000_000, false);
    expect(await decryptWif(reassemble("enc2:", raw), PASS)).toBeNull();
  });

  it("refuses an unknown future envelope version", async () => {
    const raw = bytesOf(await encryptWif(WIF, PASS));
    raw[0] = 99;
    expect(await decryptWif(reassemble("enc2:", raw), PASS)).toBeNull();
  });
});

describe("legacy V1 compatibility — the regression the KDF raise could have caused", () => {
  it("still decrypts a V1 blob written at 100k iterations", async () => {
    // ⚠ IF THIS FAILS, EVERY ALREADY-PROTECTED ACCOUNT IS LOCKED OUT, and the
    // symptom is "wrong passphrase" on a correct passphrase, with no recovery.
    // V1 blobs live in browsers' localStorage and in recovery files already
    // downloaded to disk; neither can be migrated on our schedule.
    const legacy = await legacyEncrypt(WIF, PASS);
    expect(legacy.startsWith("enc:")).toBe(true);
    expect(await decryptWif(legacy, PASS)).toBe(WIF);
  });

  it("still rejects the wrong passphrase on a V1 blob", async () => {
    expect(await decryptWif(await legacyEncrypt(WIF, PASS), "nope")).toBeNull();
  });

  it("recognises V1 as encrypted", async () => {
    expect(isEncrypted(await legacyEncrypt(WIF, PASS))).toBe(true);
  });
});

describe("upgradeNeeded", () => {
  it("flags V1 for re-encryption", async () => {
    expect(upgradeNeeded(await legacyEncrypt(WIF, PASS))).toBe(true);
  });

  it("does not flag freshly written material", async () => {
    expect(upgradeNeeded(await encryptWif(WIF, PASS))).toBe(false);
  });

  it("flags a V2 blob written at a lower cost", async () => {
    const raw = bytesOf(await encryptWif(WIF, PASS));
    new DataView(raw.buffer).setUint32(1, 100_000, false);
    expect(upgradeNeeded(reassemble("enc2:", raw))).toBe(true);
  });

  it("returns false for anything unreadable", () => {
    // ⚠ Upgrading requires decrypting first. Attempting it on data we cannot
    // parse is a route to LOSING a key, not protecting one.
    expect(upgradeNeeded("")).toBe(false);
    expect(upgradeNeeded("not encrypted")).toBe(false);
    expect(upgradeNeeded("enc2:!!!")).toBe(false);
    expect(upgradeNeeded("enc2:AA==")).toBe(false);
  });
});

describe("decryptWif — malformed input never throws", () => {
  it.each([
    ["", "empty"],
    ["not encrypted at all", "no prefix"],
    ["enc:", "V1 prefix only"],
    ["enc2:", "V2 prefix only"],
    ["enc:!!!not base64!!!", "invalid base64"],
    ["enc2:!!!not base64!!!", "invalid base64 V2"],
    ["enc:aGVsbG8=", "valid base64, too short for salt+iv"],
    ["enc2:aGVsbG8=", "valid base64, too short for a V2 header"],
    ["enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "all zeros"],
  ])("returns null for %j (%s)", async (input) => {
    await expect(decryptWif(input, PASS)).resolves.toBeNull();
  });
});

describe("isEncrypted", () => {
  it("distinguishes encrypted from plaintext storage", async () => {
    // getIdentity branches on this to decide whether a passphrase is needed. A
    // false negative on a real encrypted value would look like a lost key.
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
