/**
 * Link preview migration + store.
 *
 * Same two-halves shape as db-threading: the migration is exercised against a
 * schema that predates it (the only way to see it convert anything), and the
 * live singleton is checked separately to prove it is wired into schema init.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyLinkPreviewMigration, applyThreadingMigration, db } from "./db";
import {
  attachPreviewToPost,
  firstLinkIn,
  getPreview,
  hasPreview,
  nextStaleFailure,
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

/**
 * Retrying a transient failure.
 *
 * ⚠ THE PROPERTY BEING PROTECTED BOTH WAYS. A cached failure exists so a hostile
 * URL costs exactly one fetch however often it is posted; the retry exists so a
 * site that was merely down for a minute is not blank forever. These pull in
 * opposite directions, so both are asserted here together.
 */
describe("nextStaleFailure", () => {
  beforeEach(() => {
    db.exec("DELETE FROM link_previews");
  });

  /** A preview row with a chosen status and age. */
  function seed(url: string, status: string, hoursAgo: number) {
    savePreview(db, { url, status });
    db.prepare("UPDATE link_previews SET fetched_at = datetime('now', ?) WHERE url_hash = ?").run(
      `-${hoursAgo} hours`,
      urlHash(url)
    );
  }

  it("offers a transient failure once it has gone stale", () => {
    seed("https://example.com/a", "timeout", 48);
    expect(nextStaleFailure(db)).toBe("https://example.com/a");
  });

  it("does NOT offer a fresh failure — that is the anti-amplification guard", () => {
    // Posting a bad link a thousand times must not buy a thousand requests.
    seed("https://example.com/a", "timeout", 1);
    expect(nextStaleFailure(db)).toBeNull();
  });

  it("never retries a verdict about the URL itself", () => {
    // A private-address target does not become safe by waiting, and retrying it
    // is the SSRF probe the guard chain exists to refuse.
    for (const status of ["blocked_address", "invalid_url", "not_html"]) {
      db.exec("DELETE FROM link_previews");
      seed("https://example.com/bad", status, 24 * 365);
      expect(nextStaleFailure(db)).toBeNull();
    }
  });

  it("never retries a success", () => {
    seed("https://example.com/good", "ok", 24 * 365);
    expect(nextStaleFailure(db)).toBeNull();
  });

  it("drains oldest first", () => {
    seed("https://example.com/newer", "fetch_failed", 30);
    seed("https://example.com/older", "fetch_failed", 90);
    expect(nextStaleFailure(db)).toBe("https://example.com/older");
  });

  it("stops offering a row once it has been re-fetched", () => {
    seed("https://example.com/a", "timeout", 48);
    expect(nextStaleFailure(db)).toBe("https://example.com/a");
    // A retry writes a fresh row — success or failure, `fetched_at` moves.
    savePreview(db, { url: "https://example.com/a", status: "timeout" });
    expect(nextStaleFailure(db)).toBeNull();
  });

  it("a recovered link becomes a real preview for every post that shared it", () => {
    seed("https://example.com/a", "timeout", 48);
    savePreview(db, {
      url: "https://example.com/a",
      status: "ok",
      title: "It works now",
      description: "d",
      imageUrl: "https://example.com/i.png",
      siteName: "s",
    });
    // Keyed by url hash, so no post needs requeueing — they all already point here.
    expect(getPreview(db, urlHash("https://example.com/a"))).toMatchObject({
      status: "ok",
      title: "It works now",
    });
    expect(nextStaleFailure(db)).toBeNull();
  });
});
