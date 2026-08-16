import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyStorageKeys, STORAGE_PREFIX } from "./storage-keys";

/**
 * These tests exist because a storage-key rename is a silent data loss, not a
 * rename: the browser never connects the old name to the new one, so the user's
 * value simply stops being read. Everything below is about what an EXISTING user
 * still has after the deploy.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

function installStorages(): { local: MemoryStorage; session: MemoryStorage } {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: local, sessionStorage: session },
    configurable: true,
    writable: true,
  });
  return { local, session };
}

describe("migrateLegacyStorageKeys", () => {
  let local: MemoryStorage;
  let session: MemoryStorage;

  beforeEach(() => {
    ({ local, session } = installStorages());
  });

  it("carries an existing user's values onto the new prefix", () => {
    local.setItem("opencook_last_read_id", "2081");
    local.setItem("opencook_identity_backed_up", "1");
    local.setItem("opencook_permanence_ack", "1");
    migrateLegacyStorageKeys();
    expect(local.getItem(`${STORAGE_PREFIX}last_read_id`)).toBe("2081");
    expect(local.getItem(`${STORAGE_PREFIX}identity_backed_up`)).toBe("1");
    expect(local.getItem(`${STORAGE_PREFIX}permanence_ack`)).toBe("1");
  });

  it("migrates sessionStorage too, not just localStorage", () => {
    // opencook_inapp_continue and opencook_install_sheet_shown live here.
    session.setItem("opencook_inapp_continue", "1");
    migrateLegacyStorageKeys();
    expect(session.getItem(`${STORAGE_PREFIX}inapp_continue`)).toBe("1");
  });

  it("never overwrites a newer value already under the new name", () => {
    local.setItem("opencook_last_read_id", "10");
    local.setItem(`${STORAGE_PREFIX}last_read_id`, "2081");
    migrateLegacyStorageKeys();
    // The new key is the more recent truth — clobbering it would rewind the
    // user's read position on every subsequent page load.
    expect(local.getItem(`${STORAGE_PREFIX}last_read_id`)).toBe("2081");
  });

  it("is idempotent, so StrictMode double-invoke and repeat loads are safe", () => {
    local.setItem("opencook_saved", "yes");
    migrateLegacyStorageKeys();
    local.setItem(`${STORAGE_PREFIX}saved`, "changed-since");
    migrateLegacyStorageKeys();
    expect(local.getItem(`${STORAGE_PREFIX}saved`)).toBe("changed-since");
  });

  it("leaves the legacy entry in place rather than deleting it", () => {
    // Non-destructive: a half-written store must not lose the only copy.
    local.setItem("opencook_nym", "OCCAM");
    migrateLegacyStorageKeys();
    expect(local.getItem("opencook_nym")).toBe("OCCAM");
  });

  it("ignores keys that are not ours", () => {
    local.setItem("some_other_app_thing", "x");
    migrateLegacyStorageKeys();
    expect(local.getItem(`${STORAGE_PREFIX}some_other_app_thing`)).toBeNull();
  });

  it("copies every key, not just the first", () => {
    // Writing into a Storage while iterating its live index skips entries — this
    // is the test for the snapshot-then-write ordering.
    for (let i = 0; i < 12; i++) local.setItem(`opencook_k${i}`, String(i));
    migrateLegacyStorageKeys();
    for (let i = 0; i < 12; i++) {
      expect(local.getItem(`${STORAGE_PREFIX}k${i}`)).toBe(String(i));
    }
  });

  it("does nothing and does not throw on the server", () => {
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
    expect(() => migrateLegacyStorageKeys()).not.toThrow();
  });

  it("degrades quietly when storage throws (private mode / quota)", () => {
    const hostile = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    } as unknown as Storage;
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: hostile, sessionStorage: hostile },
      configurable: true,
    });
    expect(() => migrateLegacyStorageKeys()).not.toThrow();
  });
});
