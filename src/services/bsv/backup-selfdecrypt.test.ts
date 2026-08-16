import { describe, expect, it } from "vitest";
import { generateBackupHtml } from "./backup-template";
import { encryptWif } from "./crypto";

/**
 * CAN A RECOVERY FILE OPEN ITSELF?
 *
 * ⚠ THIS IS THE ONLY TEST THAT WOULD HAVE CAUGHT THE WORST BUG IN THIS REPO.
 * `crypto.ts` moved from V1 (`enc:`, 100000 iterations) to V2 (`enc2:`, with the
 * iteration count recorded in a header). The decrypt script frozen into every
 * recovery file kept looking for V1. The result was not a broken feature — it
 * was a backup that had NEVER worked, silently, for every file saved since the
 * change, discovered only when somebody tried to recover an account and their
 * correct passphrase was rejected.
 *
 * Every other test in this area asserted things about the file's markup. None of
 * them asserted the one property the file exists for. So this test does not
 * inspect the HTML: it EXTRACTS the decrypt code the file actually ships and
 * RUNS it against a blob produced by the real `encryptWif`.
 *
 * If you change the encryption format, this test fails until the template can
 * read it. That is the entire point — do not weaken it to a string match.
 */

/**
 * Pull the shipped decrypt implementation out of the generated file.
 *
 * Anchored on the two stable declarations that bracket it, so the test breaks
 * loudly if the block is restructured rather than silently testing nothing.
 */
function extractDecrypt(
  html: string
): (blob: string, passphrase: string) => Promise<string | null> {
  const start = html.indexOf("const LEGACY_PBKDF2_ITERATIONS");
  const end = html.indexOf("async function handleDecrypt");
  expect(start, "decrypt block not found in generated file").toBeGreaterThan(-1);
  expect(end, "handleDecrypt anchor not found in generated file").toBeGreaterThan(start);

  const code = html
    .slice(start, end)
    // The template escapes for HTML; undo the entities the block can contain.
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  const factory = new Function(
    "blob",
    "passphrase",
    `${code}\nreturn decryptStr(blob, passphrase);`
  ) as (blob: string, passphrase: string) => Promise<string | null>;
  return factory;
}

const WIF = "L1YfMhrPTuLXcYRZmYFuXjhPHYUAQyQFtpTMaKgVpJbXWnKMFhbe";
const PASSPHRASE = "correct horse battery staple";

function fileFor(encrypted: string): string {
  return generateBackupHtml({
    name: "anon_test",
    address: "19j9p7Y8kmvmdAvkNfbLaygKAu3igr2mCH",
    wif_encrypted: encrypted,
    pathType: "save",
    createdAt: "2026-08-16T13:00:00.000Z",
  });
}

describe("a recovery file can decrypt what the app encrypted", () => {
  it("opens a CURRENT-format blob with the right passphrase", async () => {
    // The exact path a user takes: the app encrypts, the file must open it.
    const encrypted = await encryptWif(WIF, PASSPHRASE);
    expect(encrypted.startsWith("enc2:"), "expected current format").toBe(true);

    const decrypt = extractDecrypt(fileFor(encrypted));
    await expect(decrypt(encrypted, PASSPHRASE)).resolves.toBe(WIF);
  });

  it("still opens a LEGACY V1 blob", async () => {
    // ⚠ Old files exist and cannot be regenerated for people who have already
    // saved them. V1 support is a description of data in the world, not a
    // preference — deleting it strands those accounts permanently.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PASSPHRASE),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(WIF))
    );
    const combined = new Uint8Array(salt.length + iv.length + ct.length);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(ct, salt.length + iv.length);
    const v1 = `enc:${btoa(String.fromCharCode(...combined))}`;

    const decrypt = extractDecrypt(fileFor(v1));
    await expect(decrypt(v1, PASSPHRASE)).resolves.toBe(WIF);
  });

  it("returns null for a wrong passphrase rather than throwing", async () => {
    const encrypted = await encryptWif(WIF, PASSPHRASE);
    const decrypt = extractDecrypt(fileFor(encrypted));
    await expect(decrypt(encrypted, "not the passphrase")).resolves.toBeNull();
  });

  it("does not mistake enc2 for enc — the prefix bug itself", async () => {
    // `'enc2:…'.startsWith('enc:')` is false, so V1-only code rejected V2
    // outright. Testing the order explicitly so a refactor cannot reintroduce it.
    const encrypted = await encryptWif(WIF, PASSPHRASE);
    const html = fileFor(encrypted);
    expect(html).toContain("enc2:");
    const decrypt = extractDecrypt(html);
    await expect(decrypt(encrypted, PASSPHRASE)).resolves.toBe(WIF);
  });

  it("returns null for junk instead of throwing", async () => {
    const decrypt = extractDecrypt(fileFor(await encryptWif(WIF, PASSPHRASE)));
    for (const junk of ["", "enc:", "enc2:", "not-encrypted-at-all", "enc2:!!!!"]) {
      await expect(decrypt(junk, PASSPHRASE)).resolves.toBeNull();
    }
  });
});
