/**
 * Browser-storage key prefix, and the migration off the old one.
 *
 * Keys are prefixed `openbook_`. They were `opencook_` until 2026-08-16, when
 * the app name changed.
 *
 * ⚠ RENAMING A STORAGE KEY IS NOT A RENAME, IT IS A DELETE. The browser has no
 * idea the two names are related: the moment the code asks for `openbook_x`, the
 * user's `opencook_x` is still sitting there, unread, forever. For these keys
 * that would have meant, for every existing user, on the deploy:
 *   - `identity_backed_up` → false, so the deposit value-gate reappears and the
 *     "save your recovery file" nag returns to people who already saved one;
 *   - `permanence_ack` → unset, so everyone is re-prompted before their next post;
 *   - `last_read_id` → unset, so the unread marker jumps to the top of the feed;
 *   - `spent_utxos` → empty, so the client can try to spend outputs it already
 *     spent, and the broadcast fails.
 * None of that loses money, but all of it is visible, and none of it is what
 * "rename the app in the code" was meant to do.
 *
 * So the old keys are COPIED, not abandoned. `migrateLegacyStorageKeys()` runs
 * once at module load — i.e. before React renders anything, which matters
 * because several of these are read in lazy `useState` initialisers during the
 * first render, and an effect-based migration would land too late.
 *
 * ⚠ DO NOT DELETE THE LEGACY PREFIX HANDLING. Any user who has not opened the
 * site since 2026-08-16 still has only the old keys.
 */

export const STORAGE_PREFIX = "openbook_";
const LEGACY_STORAGE_PREFIX = "opencook_";

/**
 * Copy every `opencook_*` entry to its `openbook_*` name, in both localStorage
 * and sessionStorage.
 *
 * Never overwrites a value that already exists under the new name — the new name
 * is always the more recent truth, so re-running this is a no-op. Idempotent and
 * safe under React StrictMode's double-invoke.
 *
 * The legacy entries are left in place rather than removed: deleting them buys
 * nothing (a handful of small strings) and would make the migration destructive
 * if it ever ran against a half-written store.
 */
export function migrateLegacyStorageKeys(): void {
  if (typeof window === "undefined") return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      // Snapshot the key list first: writing into a Storage while iterating its
      // live index is how you skip entries.
      const legacy: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(LEGACY_STORAGE_PREFIX)) legacy.push(k);
      }
      for (const oldKey of legacy) {
        const newKey = STORAGE_PREFIX + oldKey.slice(LEGACY_STORAGE_PREFIX.length);
        if (store.getItem(newKey) !== null) continue;
        const value = store.getItem(oldKey);
        if (value !== null) store.setItem(newKey, value);
      }
    } catch {
      // Private mode, disabled storage, or quota. The app already treats every
      // one of these keys as optional, so failing to migrate degrades to the
      // same place a first-time visitor starts — never to a broken state.
    }
  }
}

// Runs on import, before any component renders. See the note above on why this
// is not a `useEffect`.
migrateLegacyStorageKeys();
