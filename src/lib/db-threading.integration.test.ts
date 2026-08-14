/**
 * Threading migration (THREADS.md step 1).
 *
 * Two halves, deliberately:
 *
 *  1. Against a hand-built PRE-THREADING schema — the only way to observe the
 *     backfill actually converting rows. The live DB is migrated at import, so a
 *     test that only inspects the live DB can never see the conversion happen; it
 *     would assert the destination state and stay green if the UPDATE were deleted.
 *
 *  2. Against the LIVE db singleton — proves the migration is actually WIRED into
 *     schema init, which half 1 cannot show.
 *
 * Both are needed. Neither alone tests the answer.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyThreadingMigration } from "./db";

/** The posts table exactly as it stood before threading. */
function preThreadingDb() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
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
  return database;
}

function addLegacyPost(database: ReturnType<typeof Database>, content: string) {
  database
    .prepare("INSERT INTO posts (content, author_name) VALUES (?, ?)")
    .run(content, "anon_test");
}

function columns(database: ReturnType<typeof Database>, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  );
}

function indexNames(database: ReturnType<typeof Database>): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posts'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("applyThreadingMigration — against a pre-threading schema", () => {
  it("adds parent_id and root_id", () => {
    const database = preThreadingDb();
    expect(columns(database, "posts")).not.toContain("parent_id");

    applyThreadingMigration(database);

    expect(columns(database, "posts")).toContain("parent_id");
    expect(columns(database, "posts")).toContain("root_id");
  });

  it("BACKFILLS every legacy post to be its own thread root", () => {
    // The case the migration exists for: 2,006 genesis + pre-launch posts that
    // predate threading. Each is a root, so each must end up rooted at itself.
    const database = preThreadingDb();
    addLegacyPost(database, "genesis one");
    addLegacyPost(database, "genesis two");
    addLegacyPost(database, "genesis three");

    applyThreadingMigration(database);

    const rows = database.prepare("SELECT id, parent_id, root_id FROM posts ORDER BY id").all() as {
      id: number;
      parent_id: number | null;
      root_id: number | null;
    }[];

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.parent_id).toBeNull(); // legacy posts are roots
      expect(row.root_id).toBe(row.id); // …rooted at themselves
    }
  });

  it("leaves NO post unrooted — the footgun the backfill exists to remove", () => {
    const database = preThreadingDb();
    for (let i = 0; i < 25; i++) addLegacyPost(database, `post ${i}`);

    applyThreadingMigration(database);

    const unrooted = database
      .prepare("SELECT COUNT(*) as n FROM posts WHERE root_id IS NULL")
      .get() as { n: number };
    expect(unrooted.n).toBe(0);
  });

  it("is idempotent — re-running changes nothing", () => {
    const database = preThreadingDb();
    addLegacyPost(database, "only post");

    applyThreadingMigration(database);
    const after1 = database.prepare("SELECT id, root_id FROM posts").all();

    expect(() => applyThreadingMigration(database)).not.toThrow();
    expect(() => applyThreadingMigration(database)).not.toThrow();

    expect(database.prepare("SELECT id, root_id FROM posts").all()).toEqual(after1);
  });

  it("does not re-root a reply that already has a parent", () => {
    // Guards the backfill predicate. `WHERE root_id IS NULL AND parent_id IS NULL`
    // — drop the parent_id half and this reply is wrongly promoted to a root,
    // silently detaching it from its thread.
    const database = preThreadingDb();
    addLegacyPost(database, "root post");
    applyThreadingMigration(database);

    database
      .prepare("INSERT INTO posts (content, author_name, parent_id, root_id) VALUES (?, ?, ?, ?)")
      .run("a reply", "anon_test", 1, 1);

    applyThreadingMigration(database); // re-run

    const reply = database.prepare("SELECT parent_id, root_id FROM posts WHERE id = 2").get() as {
      parent_id: number;
      root_id: number;
    };
    expect(reply.parent_id).toBe(1);
    expect(reply.root_id).toBe(1); // still in its thread, NOT promoted to root
  });

  it("creates the two threading indexes, and no redundant third", () => {
    const database = preThreadingDb();
    applyThreadingMigration(database);

    const names = indexNames(database);
    expect(names).toContain("idx_posts_root_id");
    expect(names).toContain("idx_posts_parent_id");
    // THREADS.md specced a partial `idx_posts_roots`; measurement showed it is
    // never chosen (see the next case). Guard against it being re-added on a hunch.
    expect(names).not.toContain("idx_posts_roots");
  });

  it("the root feed is index-served with NO sort, on a reply-heavy table", () => {
    // ⚠ MEASURED, NOT ASSUMED — and the measurement changed the schema.
    // A first version created a partial index `posts(id DESC) WHERE parent_id IS
    // NULL` and asserted the planner used it. It does not: `id` is INTEGER PRIMARY
    // KEY, i.e. the rowid, so `idx_posts_parent_id` already stores (parent_id,
    // rowid) and walking its NULL span backwards yields `ORDER BY id DESC` for
    // free. The partial index was dropped as pure write cost.
    const database = preThreadingDb();
    for (let i = 0; i < 50; i++) addLegacyPost(database, `root ${i}`);
    applyThreadingMigration(database);
    const reply = database.prepare(
      "INSERT INTO posts (content, author_name, parent_id, root_id) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < 2000; i++) reply.run(`reply ${i}`, "anon_test", 1, 1);
    database.exec("ANALYZE");

    const plan = (
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM posts WHERE parent_id IS NULL ORDER BY id DESC LIMIT 100"
        )
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" ");

    expect(plan).toContain("idx_posts_parent_id");
    expect(plan).not.toMatch(/SCAN posts(?! USING)/); // no full table scan
    expect(plan).not.toContain("TEMP B-TREE"); // and no sort — this is the real win
  });

  it("the root feed returns ONLY roots", () => {
    // The plan test says the query is fast. This says it is correct.
    const database = preThreadingDb();
    for (let i = 0; i < 5; i++) addLegacyPost(database, `root ${i}`);
    applyThreadingMigration(database);
    database
      .prepare("INSERT INTO posts (content, author_name, parent_id, root_id) VALUES (?, ?, ?, ?)")
      .run("a reply", "anon_test", 1, 1);

    const feed = database
      .prepare("SELECT id, parent_id FROM posts WHERE parent_id IS NULL ORDER BY id DESC")
      .all() as { id: number; parent_id: number | null }[];

    expect(feed).toHaveLength(5);
    expect(feed.every((p) => p.parent_id === null)).toBe(true);
  });

  it("thread contents are one indexed lookup on root_id", () => {
    const database = preThreadingDb();
    applyThreadingMigration(database);

    const plan = (
      database
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM posts WHERE root_id = 1 ORDER BY id ASC")
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" ");

    expect(plan).toContain("idx_posts_root_id");
  });
});

describe("threading migration is wired into schema init", () => {
  it("the live DB has the columns and indexes", async () => {
    // integration-setup.ts sets DATABASE_PATH=':memory:' before this import, so
    // importing the singleton runs the real schema init from db.ts. This is the
    // half that proves applyThreadingMigration is actually CALLED at startup.
    const { db: liveDb } = await import("./db");

    expect(columns(liveDb, "posts")).toContain("parent_id");
    expect(columns(liveDb, "posts")).toContain("root_id");
    expect(indexNames(liveDb)).toContain("idx_posts_parent_id");
  });
});
