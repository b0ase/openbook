/**
 * BSV identity management for OpenBooks.
 * Auto-generates a keypair on first visit.
 * Supports plaintext (Phase 1) and encrypted (Phase 4) storage.
 * Private key never leaves the browser.
 */

const STORAGE_KEY = "bfn_keypair";
const OLD_IDENTITY_KEY = "bfn_identity";
const ENCRYPTED_KEY = "bfn_keypair_enc";

interface StoredIdentity {
  wif: string;
  name: string;
  address: string;
  // E30: persisted alongside address so loads avoid an extra SDK round-trip.
  // Optional for back-compat with payloads written before E30 — `getIdentity`
  // backfills + rewrites the store the first time it sees a legacy entry.
  pubkey?: string;
}

import type { Identity } from "@/types";

export type { Identity };

import { generateAnonName } from "@/lib/utils";
import { decryptWif, encryptWif, isEncrypted, upgradeNeeded } from "./crypto";

/**
 * Cached BSV SDK module promise — imported once, reused everywhere.
 */
let _bsvSdkPromise: Promise<typeof import("@bsv/sdk")> | null = null;

function getBsvSdk(): Promise<typeof import("@bsv/sdk")> {
  if (!_bsvSdkPromise) {
    _bsvSdkPromise = import("@bsv/sdk");
  }
  return _bsvSdkPromise;
}

/**
 * Cached PrivateKey — WIF never changes for a session, so parse it once.
 */
let _cachedWif: string | null = null;
let _cachedPrivateKey: import("@bsv/sdk").PrivateKey | null = null;

/**
 * Session-cached identity for encrypted mode — decrypted once per session.
 */
let _sessionIdentity: Identity | null = null;

/**
 * Clear all session-level caches that hold private-key material in memory.
 * Called on tab blur in standalone (PWA) mode, mirroring the password-manager
 * pattern used by the You modal. Without this, a backgrounded standalone tab
 * keeps the decrypted WIF + PrivateKey in memory indefinitely, which is a
 * stolen-device exposure window.
 *
 * Note: this only clears IN-MEMORY caches. localStorage is untouched — the
 * encrypted store (or plaintext store) remains, and the user can re-unlock
 * via the passphrase prompt or simply re-mount with `getIdentity()`.
 */
export function clearSessionCaches(): void {
  _sessionIdentity = null;
  _cachedWif = null;
  _cachedPrivateKey = null;
}

/** Get existing identity from storage (plaintext only). */
function getStoredIdentity(): StoredIdentity | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let parsed: StoredIdentity;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed.wif) return null;
  return parsed as StoredIdentity;
}

/**
 * Returns true ONLY when the user is actually protected by a passphrase —
 * i.e., an encrypted key exists AND no plaintext key is present. If both
 * exist (interrupted upgrade), the plaintext one is what `getIdentity()`
 * uses, so the user is effectively UNprotected and should not be routed
 * to a passphrase prompt for a passphrase they may never have completed
 * setting up.
 *
 * UI callers that gate on "does this user have a passphrase?" must use this
 * helper, NOT `isIdentityEncrypted()` which only checks for encrypted-store
 * presence.
 */
export function isEffectivelyProtected(): boolean {
  if (!isIdentityEncrypted()) return false;
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === null;
  } catch {
    // localStorage threw (private browsing quota, etc.) — fall back to the
    // narrower signal. The encrypted-store-only check is safer than assuming
    // protected when we can't read.
    return true;
  }
}

/** Check if the identity is stored in encrypted format. */
export function isIdentityEncrypted(): boolean {
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem(ENCRYPTED_KEY);
  if (raw === null) return false;
  // The encrypted store is a JSON wrapper: { encrypted: "enc:...", name, address }.
  // isEncrypted() checks for the "enc:" prefix, so we must check the inner field,
  // not the raw JSON string (which starts with "{").
  try {
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (typeof parsed.encrypted === "string") {
      return isEncrypted(parsed.encrypted);
    }
  } catch {
    // Fallback: maybe it was stored as a bare "enc:..." string (legacy).
  }
  // Legacy fallback: bare encrypted string without JSON wrapper.
  return isEncrypted(raw);
}

/**
 * Read the encrypted store's plaintext `address` metadata WITHOUT decrypting.
 * Lets getIdentity tell an interrupted encrypt-in-place (SAME key) from an
 * interrupted restore (DIFFERENT key) when both stores are present. Returns null
 * if absent/unreadable. (Finding 1, deep audit 2026-06-15.)
 */
function getEncryptedStoreAddress(): string | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ENCRYPTED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { address?: string };
    return typeof parsed.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

/**
 * True if a protected (encrypted) store is physically present — even if its JSON
 * is corrupt/unparseable. getIdentity must NEVER auto-generate a fresh key over
 * this: doing so would orphan the user's real posts/earnings behind a brand-new
 * empty anon. (Finding 3, deep audit 2026-06-15. `isIdentityEncrypted()` returns
 * false on a parse failure, so it alone does not guard this case.)
 */
export function hasEncryptedStorePresent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(ENCRYPTED_KEY);
    return raw !== null && raw.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check for old identity format (just a name string, no keypair). */
function getOldIdentityName(): string | null {
  if (typeof window === "undefined") return null;
  const oldName = localStorage.getItem(OLD_IDENTITY_KEY);
  if (oldName && /^anon_[a-z0-9]{4}$/.test(oldName)) return oldName;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    let parsed: StoredIdentity;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed.wif && parsed.name) return parsed.name;
  }
  return null;
}

/**
 * Get or create the user's identity. Returns null if encrypted (needs unlock).
 *
 * @param options.allowAutoGen — defaults to `true` (back-compat with every existing
 *   call site). When `false`, the function returns null instead of generating a
 *   fresh keypair when no identity is found. Used by the home-screen welcome gate
 *   path in `useIdentity` to defer key generation until the user explicitly chooses
 *   "Restore from your saved file." See LAUNCH_PLAN.md sequencing revision
 *   (2026-05-11) + DECISIONS.md "Welcome gate fires when standalone-mode + no identity."
 */
export async function getIdentity(options?: { allowAutoGen?: boolean }): Promise<Identity | null> {
  if (typeof window === "undefined") return null;
  const allowAutoGen = options?.allowAutoGen ?? true;

  // If session has a decrypted identity, use it
  if (_sessionIdentity) return _sessionIdentity;

  // Both stores present? Distinguish an interrupted encrypt-in-place (SAME key —
  // encryptInPlace writes the encrypted store then removes the plaintext; a crash
  // between leaves both) from an interrupted RESTORE (DIFFERENT key —
  // importEncryptedIdentity writes the encrypted NEW key then removes the OLD
  // plaintext). Comparing the stores' plaintext address metadata tells them apart
  // WITHOUT the passphrase. (Finding 1, deep audit 2026-06-15: the old code
  // unconditionally preferred the plaintext, which silently REVERTED a restore to
  // the user's old key.)
  if (isIdentityEncrypted()) {
    const plaintext = getStoredIdentity();
    if (plaintext) {
      const encAddr = getEncryptedStoreAddress();
      if (encAddr && encAddr === plaintext.address) {
        // SAME key → interrupted encrypt-in-place. Use the plaintext so the user
        // isn't locked out (same key/address).
        console.warn(
          "[OpenBooks] getIdentity: both stores present, SAME address — interrupted " +
            "encrypt-in-place. Using plaintext identity."
        );
        return await materializeFromStored(plaintext);
      }
      // DIFFERENT (or unreadable) address → interrupted RESTORE. The encrypted
      // store is the intended NEWER key; the plaintext is the stale pre-restore
      // key. Remove the stale plaintext and route to unlock so the user signs into
      // the RESTORED key, not silently reverting to the old one. NEVER touch the
      // encrypted store here — that's the just-restored identity (R1 invariant).
      console.warn(
        "[OpenBooks] getIdentity: both stores present, DIFFERENT address — interrupted " +
          "restore. Removing stale plaintext; routing to unlock."
      );
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      return null;
    }
    return null;
  }

  const stored = getStoredIdentity();
  if (stored) {
    // Double-check: if an encrypted key ALSO exists, this plaintext is stale (from a race).
    // Remove it and return null so the unlock prompt appears.
    if (isIdentityEncrypted()) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      return null;
    }
    return await materializeFromStored(stored);
  }

  // Don't generate a new key if an encrypted identity exists — OR if a raw
  // encrypted store is physically present but unparseable (truncated/corrupt).
  // Auto-genning over a corrupt-but-present protected store would orphan the
  // user's real posts/earnings behind a fresh empty anon. Return null → unlock.
  // (Finding 3, deep audit 2026-06-15.)
  if (isIdentityEncrypted() || hasEncryptedStorePresent()) return null;

  // Caller (welcome gate in standalone mode) opted out of auto-generation.
  // Returning null here keeps localStorage clean so the user's restore-from-file
  // flow is the only path to a populated identity in this sandbox.
  if (!allowAutoGen) return null;

  const oldName = getOldIdentityName();

  const { PrivateKey } = await getBsvSdk();
  const key = PrivateKey.fromRandom();
  const address = key.toAddress().toString();
  const pubkey = key.toPublicKey().toString();
  const name = oldName ?? generateAnonName();
  const wif = key.toWif();

  // Final guard before writing: re-check both keys in case a concurrent call
  // wrote something between the async getBsvSdk() await above.
  if (isIdentityEncrypted() || hasEncryptedStorePresent()) return null;
  const raceCheck = getStoredIdentity();
  if (raceCheck) {
    return await materializeFromStored(raceCheck);
  }

  const store: StoredIdentity = { wif, name, address, pubkey };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("OpenBook: could not persist identity to localStorage", err);
  }

  if (oldName) {
    try {
      localStorage.removeItem(OLD_IDENTITY_KEY);
    } catch {
      // Non-critical
    }
  }

  return { name, address, wif, pubkey };
}

/**
 * Resolve a `StoredIdentity` (read from localStorage) into a fully-formed
 * `Identity` with `pubkey`. If the stored payload lacks the pubkey field
 * (legacy entry), derive it via the BSV SDK and rewrite the localStorage entry
 * so subsequent loads skip the derive. The backfill is best-effort: if the
 * write fails (private-browsing quota, etc.), we still return the in-memory
 * Identity so the user isn't blocked.
 */
async function materializeFromStored(stored: StoredIdentity): Promise<Identity> {
  if (stored.pubkey) {
    // Pre-warm SDK so subsequent signing calls don't pay the import cost.
    getBsvSdk();
    return { name: stored.name, address: stored.address, wif: stored.wif, pubkey: stored.pubkey };
  }
  const pubkey = await derivePubkeyFromWif(stored.wif);
  try {
    const refreshed: StoredIdentity = { ...stored, pubkey };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
  } catch {
    // Backfill is non-critical — derive on the next load if write fails.
  }
  return { name: stored.name, address: stored.address, wif: stored.wif, pubkey };
}

/**
 * Derive the public key (compressed, hex) from a WIF private key. The pubkey
 * is the server-side lookup key for records associated with an identity.
 *
 * Throws if the WIF is malformed. Caller is responsible for surfacing the
 * error to the user as "invalid recovery file" or similar.
 */
export async function derivePubkeyFromWif(wif: string): Promise<string> {
  const { PrivateKey } = await getBsvSdk();
  return PrivateKey.fromWif(wif.trim()).toPublicKey().toString();
}

/**
 * Unlock an encrypted identity with a passphrase.
 * Returns the identity if passphrase is correct, null if wrong.
 * Caches the decrypted identity in memory for the session.
 */
export async function unlockIdentity(passphrase: string): Promise<Identity | null> {
  if (typeof window === "undefined") return null;

  const enc = localStorage.getItem(ENCRYPTED_KEY);
  if (!enc) return null;

  // The encrypted format stores: enc:<base64> with metadata as a JSON wrapper
  let encData: { encrypted: string; name: string; address: string };
  try {
    encData = JSON.parse(enc);
  } catch {
    return null;
  }

  const wif = await decryptWif(encData.encrypted, passphrase);
  if (!wif) return null;

  // Pre-warm SDK and cache key
  const { PrivateKey } = await getBsvSdk();
  _cachedWif = wif;
  _cachedPrivateKey = PrivateKey.fromWif(wif);
  const pubkey = _cachedPrivateKey.toPublicKey().toString();

  // Cache for session
  _sessionIdentity = { name: encData.name, address: encData.address, wif, pubkey };

  // Opportunistic KDF upgrade. THIS IS THE ONLY MOMENT IT IS POSSIBLE: re-encrypting
  // needs both the plaintext WIF and the passphrase, and they are only ever both in
  // hand immediately after a successful unlock. Legacy blobs were written at 100k
  // PBKDF2 iterations with the count hardcoded; the current envelope records it, so
  // this silently moves an existing user up to the current cost the next time they
  // sign in — no prompt, no re-download, same key and address.
  //
  // ⚠ WRITE-THEN-VERIFY, AND NEVER LET A FAILURE PROPAGATE. The unlock has already
  // succeeded by this point; the caller is entitled to their identity whatever
  // happens here. A re-encrypt that threw, or that wrote an unreadable blob, would
  // turn a routine sign-in into a lost account — strictly worse than leaving the
  // weaker-but-working envelope in place.
  if (upgradeNeeded(encData.encrypted)) {
    try {
      const reEncrypted = await encryptWif(wif, passphrase);
      if ((await decryptWif(reEncrypted, passphrase)) === wif) {
        localStorage.setItem(ENCRYPTED_KEY, JSON.stringify({ ...encData, encrypted: reEncrypted }));
      }
    } catch {
      // Keep the old envelope. It still works.
    }
  }

  return _sessionIdentity;
}

/** Sign post content. Returns signature + pubkey hex. */
export async function signPost(
  content: string
): Promise<{ signature: string; pubkey: string } | null> {
  if (typeof window === "undefined") return null;

  // Try session identity first (encrypted mode), then stored (plaintext mode)
  const wif = _sessionIdentity?.wif ?? getStoredIdentity()?.wif;
  if (!wif) return null;

  const { PrivateKey } = await getBsvSdk();

  if (_cachedWif !== wif || !_cachedPrivateKey) {
    _cachedWif = wif;
    _cachedPrivateKey = PrivateKey.fromWif(wif);
  }

  const messageBytes = Array.from(new TextEncoder().encode(content));
  const sig = _cachedPrivateKey.sign(messageBytes);

  return {
    signature: sig.toDER("hex") as string,
    pubkey: _cachedPrivateKey.toPublicKey().toString(),
  };
}

/** Pre-warm the BSV SDK by starting the download early. */
export function preWarmBsvSdk(): void {
  getBsvSdk();
}

/**
 * Read the cached anon name from the encrypted identity store WITHOUT
 * decrypting the WIF. The encrypted store is { encrypted, name, address, hint? }
 * — name is stored in plaintext so we can show it in the chip even when locked.
 * Returns null if no encrypted identity exists or the field is missing.
 */
/**
 * The ADDRESS of a locked identity, from the encrypted store's plaintext
 * wrapper.
 *
 * ⚠ THE SAME REASON THE NAME IS THERE, EXTENDED TO READ ACCESS. A protected
 * identity is LOCKED by default and the site is designed to read normally in
 * that state — so anything gated on "who is this" has to work without the key.
 * The address is a public identifier (it is in every transaction they have made)
 * and it is already stored here; the server resolves it to a pubkey through
 * `identity_addresses`.
 *
 * Read access only. Signing still needs the decrypted key, so this cannot be
 * used to write anything.
 */
export function getStoredAddress(): string | null {
  return getEncryptedStoreAddress();
}

export function getStoredAnonName(): string | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ENCRYPTED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Import a WIF and write it to the ENCRYPTED store using a caller-supplied
 * passphrase + optional hint. Used by Restore-from-file when the file was
 * passphrase-protected: the passphrase the user typed to decrypt the file
 * becomes the passphrase guarding the new identity going forward. The hint
 * from the file (if any) is preserved.
 *
 * This is the single entry point for restoring an encrypted recovery file: it
 * adopts the file's existing key (it does NOT generate a new key) and writes it
 * to the encrypted store under the supplied passphrase, so the user lands
 * protected without an extra step.
 *
 * Post-conditions (for cache coherence):
 * - STORAGE_KEY removed (so isEffectivelyProtected() returns true)
 * - ENCRYPTED_KEY populated with { encrypted, name, address, hint? }
 * - _sessionIdentity primed so signPost can fire immediately for follow-up signing
 * - _cachedWif / _cachedPrivateKey set
 */
export async function importEncryptedIdentity(
  wif: string,
  passphrase: string,
  name?: string,
  hint?: string
): Promise<Identity> {
  if (typeof window === "undefined") {
    throw new Error("importEncryptedIdentity can only run in the browser");
  }

  const trimmed = wif.trim();
  if (!trimmed) throw new Error("WIF is required");
  if (!passphrase) throw new Error("Passphrase is required to encrypt the restored key");

  const { PrivateKey } = await getBsvSdk();

  let key: import("@bsv/sdk").PrivateKey;
  try {
    key = PrivateKey.fromWif(trimmed);
  } catch {
    throw new Error("Invalid key — please check and try again");
  }

  const pubkey = key.toPublicKey().toString();
  const address = key.toPublicKey().toAddress().toString();
  const identityName = (name ?? "").trim() || generateAnonName();

  const encrypted = await encryptWif(trimmed, passphrase);
  const trimmedHint = (hint ?? "").trim();
  const storePayload = {
    encrypted,
    name: identityName,
    address,
    ...(trimmedHint ? { hint: trimmedHint } : {}),
  };

  // Write the encrypted store FIRST, then remove the plaintext. If interrupted
  // between the two, the worst case is the encrypted (restored) key is present
  // and a stale plaintext key lingers — recoverable, the user just retries. The
  // reverse order risks an interruption (tab close, iOS backgrounding, a throwing
  // setItem) leaving NEITHER key in localStorage, permanently losing the
  // just-restored identity. (Key-safety audit finding R1, 2026-06-13.)
  localStorage.setItem(ENCRYPTED_KEY, JSON.stringify(storePayload));
  localStorage.removeItem(STORAGE_KEY);

  // Prime session caches so any follow-up signing (post creation, boot, etc.)
  // works without forcing the user to re-unlock. The encrypted-store path
  // normally requires unlockIdentity(passphrase) before signing — we skip
  // that here because we JUST received the passphrase from the user.
  _sessionIdentity = { name: identityName, address, wif: trimmed, pubkey };
  _cachedWif = trimmed;
  _cachedPrivateKey = key;

  return { name: identityName, address, wif: trimmed, pubkey };
}

/**
 * Encrypt the user's EXISTING plaintext key in place under a passphrase.
 *
 * Encrypt-in-place: same key, same address, no new key, no migration, no sweep.
 * This is the "add a passphrase" path for an UNPROTECTED user. (DECISIONS.md
 * "Key rotation REMOVED in favor of encrypt-in-place".)
 *
 * Post-conditions (mirror importEncryptedIdentity for cache coherence):
 * - ENCRYPTED_KEY populated with { encrypted, name, address, hint? }
 * - STORAGE_KEY removed (so isEffectivelyProtected() returns true)
 * - session caches primed to the SAME key so signPost fires without re-unlock
 *
 * SAFE ORDER: encrypt → verify-decrypt → write encrypted → remove plaintext.
 * We verify-decrypt the ciphertext before persisting so we never write an
 * unreadable encrypted store, and we write the encrypted key FIRST / remove the
 * plaintext SECOND so an interruption can never leave NEITHER key present
 * (key-safety audit finding R1).
 */
export async function encryptInPlace(passphrase: string, hint?: string): Promise<Identity> {
  if (typeof window === "undefined") {
    throw new Error("encryptInPlace can only run in the browser");
  }
  if (!passphrase) throw new Error("Passphrase is required");
  if (isIdentityEncrypted()) {
    // Already has an encrypted store — adding a passphrase is the wrong tool.
    // Changing it is changePassphrase()'s job.
    throw new Error("Identity is already protected — use changePassphrase");
  }

  // Resolve the current plaintext identity WITHOUT generating a fresh key.
  const identity = await getIdentity({ allowAutoGen: false });
  if (!identity) throw new Error("No key to protect");

  const { name, address, wif, pubkey } = identity;

  const { PrivateKey } = await getBsvSdk();

  // Encrypt the EXISTING wif (same key, same address).
  const encrypted = await encryptWif(wif, passphrase);

  // Self-check: decrypt the ciphertext we just produced and assert it round-trips
  // to the original WIF. Guarantees we never persist an unreadable encrypted
  // store. If this fails we have NOT touched localStorage — plaintext is intact.
  const roundTrip = await decryptWif(encrypted, passphrase);
  if (roundTrip !== wif) {
    throw new Error("Encryption self-check failed, key not changed");
  }

  const trimmedHint = (hint ?? "").trim();
  const storePayload = {
    encrypted,
    name,
    address,
    ...(trimmedHint ? { hint: trimmedHint } : {}),
  };

  // Write the encrypted store FIRST, then remove the plaintext. Never the reverse:
  // the reverse order risks an interruption (tab close, iOS backgrounding, a
  // throwing setItem) leaving NEITHER key in localStorage. (Key-safety audit R1.)
  localStorage.setItem(ENCRYPTED_KEY, JSON.stringify(storePayload));
  localStorage.removeItem(STORAGE_KEY);

  // Prime session caches to the SAME key so any follow-up signing works without
  // forcing the user to re-unlock the passphrase they just set.
  _sessionIdentity = { name, address, wif, pubkey };
  _cachedWif = wif;
  _cachedPrivateKey = PrivateKey.fromWif(wif);

  return { name, address, wif, pubkey };
}

/**
 * Change the passphrase guarding an already-PROTECTED identity.
 *
 * Decrypts the existing encrypted store with the old passphrase and re-encrypts
 * the SAME key under the new passphrase. Same key, same address — only the
 * passphrase (and the salt/iv baked into the ciphertext) change.
 *
 * Returns { ok: false, reason: "wrong_passphrase" } having touched NO storage if
 * the old passphrase doesn't decrypt the store. The wrong-passphrase guard lives
 * INSIDE this function by design: a caller must never overwrite the encrypted
 * store with a key it didn't successfully decrypt.
 */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  hint?: string
): Promise<{ ok: true } | { ok: false; reason: "wrong_passphrase" }> {
  if (typeof window === "undefined") {
    throw new Error("changePassphrase can only run in the browser");
  }

  const raw = localStorage.getItem(ENCRYPTED_KEY);
  if (!raw) throw new Error("No protected identity to change");

  let encData: { encrypted: string; name: string; address: string };
  try {
    encData = JSON.parse(raw);
  } catch {
    throw new Error("Protected identity store is corrupted");
  }

  // Verify the OLD passphrase before touching anything. decryptWif returns null
  // on a wrong passphrase (AES-GCM auth-tag failure) — it does not throw.
  const wif = await decryptWif(encData.encrypted, oldPassphrase);
  if (!wif) return { ok: false, reason: "wrong_passphrase" };

  // Validate the new passphrase BEFORE any write.
  if (!newPassphrase || newPassphrase.length < 8) {
    throw new Error("New passphrase must be at least 8 characters");
  }
  if (newPassphrase === oldPassphrase) {
    throw new Error("New passphrase must be different from the old one");
  }

  const { PrivateKey } = await getBsvSdk();

  // Re-encrypt the SAME decrypted wif under the new passphrase.
  const encrypted = await encryptWif(wif, newPassphrase);

  // Self-check the NEW ciphertext round-trips BEFORE overwriting the old (still
  // working) store. Without this, an unreadable new ciphertext would overwrite a
  // good one and lock the user out of their own key on next load. Symmetric with
  // encryptInPlace; the old store is left intact if this throws.
  const roundTrip = await decryptWif(encrypted, newPassphrase);
  if (roundTrip !== wif) {
    throw new Error("Encryption self-check failed, passphrase not changed");
  }

  const trimmedHint = (hint ?? "").trim();
  const storePayload = {
    encrypted,
    name: encData.name,
    address: encData.address,
    ...(trimmedHint ? { hint: trimmedHint } : {}),
  };

  // Single overwrite of the encrypted store — no remove, no neither-state.
  localStorage.setItem(ENCRYPTED_KEY, JSON.stringify(storePayload));

  // Prime caches to the same key (re-encrypting changed the ciphertext, not the
  // key, so the in-memory WIF is still valid).
  const key = PrivateKey.fromWif(wif);
  _sessionIdentity = {
    name: encData.name,
    address: encData.address,
    wif,
    pubkey: key.toPublicKey().toString(),
  };
  _cachedWif = wif;
  _cachedPrivateKey = key;

  return { ok: true };
}
