/**
 * Link preview migration + store.
 *
 * Same two-halves shape as db-threading: the migration is exercised against a
 * schema that predates it (the only way to see it convert anything), and the
 * live singleton is checked separately to prove it is wired into schema init.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyLinkPreviewMigration, applyThreadingMigration } from "./db";
import {
  attachPreviewToPost,
  firstLinkIn,
  getPreview,
  hasPreview,
  savePreview,
  urlHash,
} from "./link-preview-store";

function preMigrationDb() {
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

function migrated() {
  const database = preMigrationDb();
  applyThreadingMigration(database);
  applyLinkPreviewMigration(database);
  return database;
}

function addPost(database: ReturnType<typeof Database>, content = "hi"): number {
  const r = database
    .prepare("INSERT INTO posts (content, author_name) VALUES (?, ?)")
    .run(content, "anon_test");
  return r.lastInsertRowid as number;
}

describe("applyLinkPreviewMigration", () => {
  it("creates link_previews and posts.preview_hash", () => {
    const database = preMigrationDb();
    applyThreadingMigration(database);
    applyLinkPreviewMigration(database);

    const cols = (database.prepare("PRAGMA table_info(posts)").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain("preview_hash");

    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='link_previews'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(["link_previews"]);
  });

  it("is idempotent", () => {
    const database = migrated();
    expect(() => applyLinkPreviewMigration(database)).not.toThrow();
    expect(() => applyLinkPreviewMigration(database)).not.toThrow();
  });

  it("leaves existing posts with a null preview_hash", () => {
    const database = preMigrationDb();
    addPost(database, "an old post");
    applyThreadingMigration(database);
    applyLinkPreviewMigration(database);

    const row = database.prepare("SELECT preview_hash FROM posts WHERE id = 1").get() as {
      preview_hash: string | null;
    };
    expect(row.preview_hash).toBeNull();
  });
});

describe("preview store", () => {
  it("round-trips a successful preview", () => {
    const database = migrated();
    const hash = savePreview(database, {
      url: "https://example.com/",
      status: "ok",
      title: "T",
      description: "D",
      imageUrl: "https://example.com/i.png",
      siteName: "Example",
    });

    const row = getPreview(database, hash);
    expect(row?.title).toBe("T");
    expect(row?.status).toBe("ok");
    expect(hash).toBe(urlHash("https://example.com/"));
  });

  it("CACHES FAILURES — a hostile URL costs exactly one fetch, ever", () => {
    // ⚠ THE SECURITY-RELEVANT ONE. If a blocked URL were absent from the table,
    // every repost of it would trigger a fresh outbound request, turning one bad
    // link into an unbounded request amplifier.
    const database = migrated();
    savePreview(database, { url: "http://169.254.169.254/", status: "blocked_address" });

    expect(hasPreview(database, "http://169.254.169.254/")).toBe(true);
    expect(getPreview(database, urlHash("http://169.254.169.254/"))?.status).toBe(
      "blocked_address"
    );
  });

  it("upserts — a later success overwrites an earlier failure", () => {
    const database = migrated();
    const url = "https://example.com/";
    savePreview(database, { url, status: "timeout" });
    savePreview(database, { url, status: "ok", title: "Now works" });

    const row = getPreview(database, urlHash(url));
    expect(row?.status).toBe("ok");
    expect(row?.title).toBe("Now works");

    const count = database.prepare("SELECT COUNT(*) as n FROM link_previews").get() as {
      n: number;
    };
    expect(count.n).toBe(1); // upserted, not duplicated
  });

  it("reports no preview for an unseen URL", () => {
    expect(hasPreview(migrated(), "https://never-seen.example/")).toBe(false);
  });

  it("attaches a preview to a post, and the join returns it", () => {
    const database = migrated();
    const postId = addPost(database, "look https://example.com/");
    const hash = savePreview(database, {
      url: "https://example.com/",
      status: "ok",
      title: "Joined",
    });
    attachPreviewToPost(database, postId, hash);

    const row = database
      .prepare(`
        SELECT p.id, lp.title as preview_title, lp.status as preview_status
        FROM posts p LEFT JOIN link_previews lp ON lp.url_hash = p.preview_hash
        WHERE p.id = ?
      `)
      .get(postId) as { preview_title: string | null; preview_status: string | null };

    expect(row.preview_title).toBe("Joined");
    expect(row.preview_status).toBe("ok");
  });

  it("a post with no preview still comes back from the LEFT JOIN", () => {
    // A LEFT JOIN that accidentally became an INNER JOIN would silently drop
    // every post without a link — i.e. almost the entire feed.
    const database = migrated();
    const postId = addPost(database, "no links here");

    const row = database
      .prepare(`
        SELECT p.id, lp.title as preview_title
        FROM posts p LEFT JOIN link_previews lp ON lp.url_hash = p.preview_hash
        WHERE p.id = ?
      `)
      .get(postId) as { id: number; preview_title: string | null };

    expect(row.id).toBe(postId);
    expect(row.preview_title).toBeNull();
  });
});

describe("firstLinkIn", () => {
  it("returns only the first link — one fetch per post, by design", () => {
    expect(firstLinkIn("a https://one.com b https://two.com")).toBe("https://one.com/");
  });

  it("returns null when there is no link", () => {
    expect(firstLinkIn("just some words")).toBeNull();
    expect(firstLinkIn("")).toBeNull();
  });
});

describe("wired into schema init", () => {
  it("the live DB has link_previews and posts.preview_hash", async () => {
    const { db: liveDb } = await import("./db");
    const cols = (liveDb.prepare("PRAGMA table_info(posts)").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain("preview_hash");
    expect(
      liveDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='link_previews'")
        .get()
    ).toBeDefined();
  });
});
