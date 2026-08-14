import { PrivateKey } from "@bsv/sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAIRNESS_CONFIG } from "./config";
import {
  _clearWeightsCache,
  type ContributorWeight,
  calculateWeights,
  getWeightSource,
  postActivityWeightSource,
  resetWeightSource,
  setWeightSource,
  type WeightSource,
} from "./weights";

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      author_name TEXT NOT NULL,
      signature TEXT,
      pubkey TEXT,
      tx_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE bootboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      boosted_by TEXT NOT NULL,
      booted_at TEXT NOT NULL DEFAULT (datetime('now')),
      held_until TEXT,
      boosted_by_name TEXT,
      is_free INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (post_id) REFERENCES posts(id)
    )
  `);
  return db;
}

function makeKey() {
  const priv = PrivateKey.fromRandom();
  return {
    pubkey: priv.toPublicKey().toString(),
    address: priv.toPublicKey().toAddress().toString(),
  };
}

// Far-past launch epoch for the pre-existing logic tests: with the real config
// default now a far-FUTURE sentinel ("2999-…"), these fixtures (dated ~now) would
// all be pre-launch and excluded. Passing an explicit past cutoff isolates the
// weight/decay/aggregation logic from the launch cutoff. The launch cutoff itself
// is covered by the dedicated "launchTs cutoff" cases below.
const PAST = "2000-01-01 00:00:00";

function addPost(db: ReturnType<typeof Database>, pubkey: string, minutesAgo = 0) {
  const created = new Date(Date.now() - minutesAgo * 60_000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .slice(0, 19);
  db.prepare(
    "INSERT INTO posts (content, author_name, pubkey, created_at) VALUES (?, ?, ?, ?)"
  ).run("test post", "anon_test", pubkey, created);
}

/** Insert a post at an explicit space-format created_at (for launchTs cutoff tests). */
function addPostAt(db: ReturnType<typeof Database>, pubkey: string, createdAt: string) {
  db.prepare(
    "INSERT INTO posts (content, author_name, pubkey, created_at) VALUES (?, ?, ?, ?)"
  ).run("test post", "anon_test", pubkey, createdAt);
}

function addBoot(db: ReturnType<typeof Database>, postId: number) {
  db.prepare("INSERT INTO bootboard (post_id, boosted_by) VALUES (?, ?)").run(postId, "someone");
}

describe("calculateWeights", () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    _clearWeightsCache();
    db = createTestDb();
  });

  it("returns empty array for empty DB", () => {
    expect(calculateWeights(db, PAST)).toHaveLength(0);
  });

  it("returns empty for unsigned posts only", () => {
    db.prepare("INSERT INTO posts (content, author_name) VALUES (?, ?)").run("unsigned", "anon");
    expect(calculateWeights(db, PAST)).toHaveLength(0);
  });

  it("returns one contributor for a single signed post", () => {
    const key = makeKey();
    addPost(db, key.pubkey);
    const weights = calculateWeights(db, PAST);

    expect(weights).toHaveLength(1);
    expect(weights[0].pubkey).toBe(key.pubkey);
    expect(weights[0].address).toBe(key.address);
    expect(weights[0].weight).toBeGreaterThan(0);
    expect(weights[0].postCount).toBe(1);
    expect(weights[0].totalBoots).toBe(0);
  });

  it("aggregates multiple posts from same contributor", () => {
    const key = makeKey();
    addPost(db, key.pubkey, 0);
    addPost(db, key.pubkey, 5);
    const weights = calculateWeights(db, PAST);

    expect(weights).toHaveLength(1);
    expect(weights[0].postCount).toBe(2);
    // Two posts should produce higher total weight than one
    expect(weights[0].weight).toBeGreaterThan(1);
  });

  it("separates different contributors", () => {
    const keyA = makeKey();
    const keyB = makeKey();
    addPost(db, keyA.pubkey, 0);
    addPost(db, keyB.pubkey, 0);
    const weights = calculateWeights(db, PAST);

    expect(weights).toHaveLength(2);
    const pubkeys = weights.map((w) => w.pubkey);
    expect(pubkeys).toContain(keyA.pubkey);
    expect(pubkeys).toContain(keyB.pubkey);
  });

  it("boots increase weight via engagement multiplier", () => {
    const key = makeKey();
    addPost(db, key.pubkey, 0);
    const postId = (
      db.prepare("SELECT id FROM posts ORDER BY id DESC LIMIT 1").get() as { id: number }
    ).id;

    const weightBefore = calculateWeights(db, PAST)[0].weight;

    // Add 3 boots and clear cache to force recalc
    addBoot(db, postId);
    addBoot(db, postId);
    addBoot(db, postId);
    _clearWeightsCache();

    const weightsAfter = calculateWeights(db, PAST);
    expect(weightsAfter[0].weight).toBeGreaterThan(weightBefore);
    expect(weightsAfter[0].totalBoots).toBe(3);
  });

  it("older posts have lower weight (time decay)", () => {
    const key = makeKey();
    // One recent post and one 30-day old post from the same contributor
    addPost(db, key.pubkey, 0); // recent — high decay
    addPost(db, key.pubkey, 30 * 24 * 60); // 30 days — half-life decay

    const weights = calculateWeights(db, PAST);
    expect(weights).toHaveLength(1);
    // With half-life = 30 days, recent post contributes ~1.0, old post ~0.5
    // Total should be ~1.5, proving the old post decayed (not equal to recent)
    expect(weights[0].weight).toBeGreaterThan(1);
    expect(weights[0].weight).toBeLessThan(2); // would be 2 if no decay
  });

  it("does not produce NaN from SQLite datetime format", () => {
    const key = makeKey();
    // Insert with SQLite's native datetime() which produces space-separated format
    db.prepare(
      "INSERT INTO posts (content, author_name, pubkey, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).run("test", "anon", key.pubkey);

    const weights = calculateWeights(db, PAST);
    expect(weights).toHaveLength(1);
    expect(weights[0].weight).toBeGreaterThan(0);
    expect(Number.isNaN(weights[0].weight)).toBe(false);
  });

  // --- launchTs pool cutoff: pre-launch history is excluded from the 80% pool ---

  it("excludes pre-launch posts from the pool (launchTs cutoff)", () => {
    const key = makeKey();
    addPostAt(db, key.pubkey, "2026-05-01 12:00:00"); // before the cutoff
    // A post entirely before launch contributes zero pool weight.
    expect(calculateWeights(db, "2026-06-01 00:00:00")).toHaveLength(0);
  });

  it("includes post-launch posts (launchTs cutoff)", () => {
    const key = makeKey();
    addPostAt(db, key.pubkey, "2026-07-01 12:00:00"); // after the cutoff
    const weights = calculateWeights(db, "2026-06-01 00:00:00");
    expect(weights).toHaveLength(1);
    expect(weights[0].pubkey).toBe(key.pubkey);
    expect(weights[0].weight).toBeGreaterThan(0);
  });

  it("a post exactly at the launch instant counts as post-launch (>=)", () => {
    const key = makeKey();
    addPostAt(db, key.pubkey, "2026-06-01 00:00:00"); // exactly at the cutoff
    expect(calculateWeights(db, "2026-06-01 00:00:00")).toHaveLength(1);
  });

  it("a pubkey posting before AND after launch only counts its post-launch post", () => {
    const key = makeKey();
    addPostAt(db, key.pubkey, "2026-05-01 12:00:00"); // pre-launch — excluded
    addPostAt(db, key.pubkey, "2026-07-01 12:00:00"); // post-launch — counted
    const weights = calculateWeights(db, "2026-06-01 00:00:00");
    expect(weights).toHaveLength(1);
    expect(weights[0].pubkey).toBe(key.pubkey);
    expect(weights[0].postCount).toBe(1); // only the post-launch post
  });
});

// --- WeightSource registry: the seam a token-backed source would plug into ---

describe("WeightSource registry", () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    resetWeightSource();
    _clearWeightsCache();
    db = createTestDb();
  });

  afterEach(() => {
    // Never leak a stub source into another test file — the registry is
    // process-global, same as the weight cache.
    resetWeightSource();
  });

  /** Minimal stub source that records how it was called. */
  function makeStubSource(rows: ContributorWeight[] = []) {
    const calls: string[] = [];
    let cleared = 0;
    const source: WeightSource = {
      name: "stub",
      calculate: (_db, launchTs) => {
        calls.push(launchTs);
        return rows;
      },
      clearCache: () => {
        cleared += 1;
      },
    };
    return {
      source,
      calls,
      clearedCount: () => cleared,
    };
  }

  it("defaults to the post-activity source", () => {
    expect(getWeightSource()).toBe(postActivityWeightSource);
    expect(getWeightSource().name).toBe("post-activity");
  });

  it("routes calculateWeights through the registered source", () => {
    const key = makeKey();
    const stubRow: ContributorWeight = {
      pubkey: key.pubkey,
      address: key.address,
      weight: 42,
      postCount: 7,
      totalBoots: 3,
    };
    const stub = makeStubSource([stubRow]);
    setWeightSource(stub.source);

    // The DB has a real post, but the stub source ignores it entirely —
    // proving the weight vector comes from the source, not the posts table.
    addPost(db, makeKey().pubkey);
    expect(calculateWeights(db, PAST)).toEqual([stubRow]);
  });

  it("passes launchTs through to the source", () => {
    const stub = makeStubSource();
    setWeightSource(stub.source);

    calculateWeights(db, "2026-06-01 00:00:00");
    expect(stub.calls).toEqual(["2026-06-01 00:00:00"]);
  });

  it("defaults launchTs to the configured launch epoch", () => {
    const stub = makeStubSource();
    setWeightSource(stub.source);

    calculateWeights(db);
    expect(stub.calls).toEqual([FAIRNESS_CONFIG.launchTs]);
  });

  it("clears both sources' caches on swap, so no stale cross-strategy weights", () => {
    const key = makeKey();
    addPost(db, key.pubkey);
    // Warm the default source's cache.
    expect(calculateWeights(db, PAST)).toHaveLength(1);

    const stub = makeStubSource();
    setWeightSource(stub.source);
    // Incoming source was cleared on the way in.
    expect(stub.clearedCount()).toBe(1);

    // Swapping back must not serve the stub's results, nor the default's stale cache.
    resetWeightSource();
    expect(calculateWeights(db, PAST)).toHaveLength(1);
  });

  it("is a no-op when setting the already-active source", () => {
    const stub = makeStubSource();
    setWeightSource(stub.source);
    expect(stub.clearedCount()).toBe(1);

    setWeightSource(stub.source);
    expect(stub.clearedCount()).toBe(1); // unchanged — no redundant clear
  });

  it("_clearWeightsCache targets the active source", () => {
    const stub = makeStubSource();
    setWeightSource(stub.source);
    const before = stub.clearedCount();

    _clearWeightsCache();
    expect(stub.clearedCount()).toBe(before + 1);
  });

  it("resetWeightSource restores post-activity behaviour", () => {
    setWeightSource(makeStubSource().source);
    resetWeightSource();

    const key = makeKey();
    addPost(db, key.pubkey);
    const weights = calculateWeights(db, PAST);
    expect(getWeightSource()).toBe(postActivityWeightSource);
    expect(weights).toHaveLength(1);
    expect(weights[0].pubkey).toBe(key.pubkey);
  });
});
