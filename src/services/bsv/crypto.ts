/**
 * AES-256-GCM encryption for BSV WIF keys.
 * Uses Web Crypto API — no external dependencies.
 * The passphrase is never stored — only used to derive the AES key.
 *
 * ── TWO ENVELOPE FORMATS, AND WHY ───────────────────────────────────────────
 *
 * V1  "enc:"  base64( salt(16) ‖ iv(12) ‖ ciphertext )              — LEGACY
 * V2  "enc2:" base64( ver(1) ‖ iters(4 BE) ‖ salt(16) ‖ iv(12) ‖ ciphertext )
 *
 * V1 hardcoded its iteration count. That is the whole problem: raising the count
 * would change the derived key, so every existing encrypted identity would fail
 * to decrypt — and fail INDISTINGUISHABLY FROM A WRONG PASSPHRASE, because GCM
 * just rejects the tag. Users would type the correct passphrase, be told it was
 * wrong, and have no recovery path. The number could therefore never be raised.
 *
 * V2 stores the parameters it was encrypted with, so the cost can be raised for
 * new material without stranding old material. Reading is driven by the
 * envelope; writing always uses the current constants.
 *
 * ⚠ V1 MUST KEEP DECRYPTING, FOREVER-ISH. Encrypted WIFs live in two places
 * outside this app's control: `bfn_keypair_enc` in a browser's localStorage, and
 * recovery files people have already downloaded to disk. Neither can be
 * migrated on our schedule. `upgradeNeeded()` lets callers re-encrypt a V1 blob
 * opportunistically after a successful unlock, which is the only moment the
 * plaintext and the passphrase are both in hand.
 */

/** Iterations for NEW material. Raising this is now safe — V2 records it. */
const PBKDF2_ITERATIONS = 600_000;
/** What V1 always used. Never change: it is a description of existing data. */
const LEGACY_PBKDF2_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const ENCRYPTED_PREFIX = "enc:";
const ENCRYPTED_PREFIX_V2 = "enc2:";
const ENVELOPE_VERSION = 2;

/**
 * Derive an AES-256 key from a passphrase and salt using PBKDF2.
 */
async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Encrypt a WIF string with a passphrase. Always writes the current (V2) format.
 * Returns "enc2:<base64(version + iterations + salt + iv + ciphertext)>".
 */
export async function encryptWif(wif: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    new TextEncoder().encode(wif) as BufferSource
  );

  const header = 1 + 4;
  const combined = new Uint8Array(header + SALT_BYTES + IV_BYTES + ciphertext.byteLength);
  combined[0] = ENVELOPE_VERSION;
  // Iterations, 4-byte big-endian. Bounded by the uint32 range, which is far
  // above any sane KDF cost.
  new DataView(combined.buffer).setUint32(1, PBKDF2_ITERATIONS, false);
  combined.set(salt, header);
  combined.set(iv, header + SALT_BYTES);
  combined.set(new Uint8Array(ciphertext), header + SALT_BYTES + IV_BYTES);

  return ENCRYPTED_PREFIX_V2 + toBase64(combined);
}

/**
 * Decrypt a WIF encrypted in either format.
 * Returns the WIF on success, null if the passphrase is wrong or data is bad.
 *
 * Never throws: callers branch on null, and a throw would surface as a crash
 * mid-unlock rather than a "wrong passphrase" message.
 */
export async function decryptWif(encrypted: string, passphrase: string): Promise<string | null> {
  const isV2 = encrypted.startsWith(ENCRYPTED_PREFIX_V2);
  const isV1 = !isV2 && encrypted.startsWith(ENCRYPTED_PREFIX);
  if (!isV1 && !isV2) return null;

  try {
    const data = encrypted.slice((isV2 ? ENCRYPTED_PREFIX_V2 : ENCRYPTED_PREFIX).length);
    const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

    let offset = 0;
    let iterations = LEGACY_PBKDF2_ITERATIONS;

    if (isV2) {
      // Header must be fully present before any of it is read.
      if (combined.length < 5 + SALT_BYTES + IV_BYTES) return null;
      const version = combined[0];
      if (version !== ENVELOPE_VERSION) return null; // a future format we can't read
      iterations = new DataView(
        combined.buffer,
        combined.byteOffset,
        combined.byteLength
      ).getUint32(1, false);
      // Refuse absurd work factors rather than hanging the browser on a crafted
      // envelope claiming four billion iterations.
      if (iterations < 1_000 || iterations > 10_000_000) return null;
      offset = 5;
    } else if (combined.length < SALT_BYTES + IV_BYTES) {
      return null;
    }

    const salt = combined.slice(offset, offset + SALT_BYTES);
    const iv = combined.slice(offset + SALT_BYTES, offset + SALT_BYTES + IV_BYTES);
    const ciphertext = combined.slice(offset + SALT_BYTES + IV_BYTES);

    const key = await deriveKey(passphrase, salt, iterations);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      ciphertext.buffer as ArrayBuffer
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong passphrase or corrupted data
    return null;
  }
}

/**
 * Check if a stored value is in encrypted format (either version).
 */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX_V2) || stored.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Should this blob be re-encrypted at the current cost?
 *
 * True for V1 (weaker, fixed count) and for any V2 written at fewer iterations
 * than we now use. Re-encrypting needs the passphrase, so the only moment a
 * caller can act on this is immediately after a successful unlock.
 *
 * Returns false for anything unparseable — an upgrade attempt on data we cannot
 * read would be a way to LOSE a key, not protect one.
 */
export function upgradeNeeded(stored: string): boolean {
  if (stored.startsWith(ENCRYPTED_PREFIX_V2)) {
    try {
      const combined = Uint8Array.from(atob(stored.slice(ENCRYPTED_PREFIX_V2.length)), (c) =>
        c.charCodeAt(0)
      );
      if (combined.length < 5) return false;
      const iterations = new DataView(
        combined.buffer,
        combined.byteOffset,
        combined.byteLength
      ).getUint32(1, false);
      return iterations < PBKDF2_ITERATIONS;
    } catch {
      return false;
    }
  }
  return stored.startsWith(ENCRYPTED_PREFIX);
}
