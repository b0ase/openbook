/**
 * Local cache of the identity's claimed `$Nym`.
 *
 * `getNym` is a server round-trip, so without a cache every surface that shows
 * the user's name paints `anon_xxxx` first and swaps once the lookup lands — a
 * visible flip showing exactly the name a nym was claimed to stop seeing. Two
 * places need it before any server answer exists: the identity chip on first
 * paint (including while LOCKED, where there is no pubkey to look up), and an
 * optimistic post, which is rendered from client state ~500ms before the feed
 * poll returns the real row.
 *
 * ⚠ STORED WITH ITS PUBKEY. Restoring a different identity on this device would
 * otherwise show the previous holder's name. On a mismatch the cache is ignored
 * and the authoritative `getNym` overwrites it. Callers that cannot supply a
 * pubkey (the locked chip) get the cached value unchecked — the same assumption
 * `getStoredAnonName()` already makes about the stored identity, and it
 * self-corrects on unlock.
 */

const NYM_KEY = "openbook_nym";

export function readCachedNym(pubkey?: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(NYM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pubkey?: unknown; symbol?: unknown };
    if (typeof parsed.symbol !== "string" || !parsed.symbol) return null;
    if (pubkey && parsed.pubkey !== pubkey) return null;
    return parsed.symbol;
  } catch {
    // Corrupt entry or storage disabled — an absent nym is always safe to
    // render, since the anon handle is the designed fallback.
    return null;
  }
}

export function writeCachedNym(pubkey: string, symbol: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (symbol) {
      window.localStorage.setItem(NYM_KEY, JSON.stringify({ pubkey, symbol }));
    } else {
      window.localStorage.removeItem(NYM_KEY);
    }
  } catch {
    // Private mode / quota — the nym still renders this session from state.
  }
}
