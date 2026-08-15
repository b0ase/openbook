/**
 * The ticker-tree repair.
 *
 * Two bugs reached production and are frozen into existing rows, so the migration
 * has to REPAIR data rather than only shape new writes:
 *
 *  1. The tree pointed UP — `$branch/$test` — because an earlier backfill inferred
 *     a parent without requiring it to have been claimed earlier.
 *  2. A ticker claimed inside a thread kept the ENCLOSING thread's `root_id`, so
 *     clicking it re-opened its parent instead of the new idea.
 *
 * Fixing only (1) would give a correct-looking path that still navigates to the
 * wrong thread, which is why both are asserted here together.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyTickerMigration } from "./db";

type Db = ReturnType<typeof Database>;
let db: Db;

/** A database in the exact broken state the live site was in. */
function seedBrokenState(database: Db) {
  database.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      author_name TEXT NOT NULL,
      tx_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      signature TEXT, pubkey TEXT,
      parent_id INTEGER, root_id INTEGER, preview_hash TEXT
    )
  `);
  // $test at a root post; $branch claimed in a REPLY to it.
  database
    .prepare("INSERT INTO posts (id,content,author_name,parent_id,root_id) VALUES (1,?,?,NULL,1)")
    .run("$test", "anon_a");
  database
    .prepare("INSERT INTO posts (id,content,author_name,parent_id,root_id) VALUES (2,?,?,1,1)")
    .run("naming $branch in here", "anon_a");
}

const tickerRows = () =>
  db.prepare("SELECT symbol, root_id, parent_symbol FROM tickers ORDER BY symbol").all() as {
    symbol: string;
    root_id: number;
    parent_symbol: string | null;
  }[];

beforeEach(() => {
  db = new Database(":memory:");
  seedBrokenState(db);
  applyTickerMigration(db); // creates the table on a fresh DB
  // Now write the BROKEN rows an older build would have produced.
  db.prepare(
    "INSERT INTO tickers (symbol, post_id, root_id, parent_symbol) VALUES ('TEST',1,1,'BRANCH')"
  ).run();
  db.prepare(
    "INSERT INTO tickers (symbol, post_id, root_id, parent_symbol) VALUES ('BRANCH',2,1,NULL)"
  ).run();
});

describe("repairing the inverted tree", () => {
  it("turns $branch/$test the right way up", () => {
    applyTickerMigration(db);
    const rows = Object.fromEntries(tickerRows().map((r) => [r.symbol, r.parent_symbol]));
    // $test was claimed at a root post with nothing enclosing it, so it is
    // TOP-LEVEL and has no parent at all.
    //
    // ⚠ It used to assert `ROOT_TICKER` here. Reversed 2026-08-15: parenting
    // every feed-level claim to `$OpenBooks` put a prefix on every top-level
    // token, which therefore told you nothing about any of them, and made the
    // root simultaneously a member of the ticker set and the container of it.
    // Real branching — the `BRANCH → TEST` line below — is what parentage is
    // for, and it is untouched.
    expect(rows.TEST).toBeNull();
    // $branch was named inside $test's thread, so $test is its parent.
    expect(rows.BRANCH).toBe("TEST");
  });

  it("repairs a parent that is WRONG, not merely missing", () => {
    // The earlier fix guarded on `parent_symbol IS NULL`, which could never have
    // corrected TEST — its parent was populated and inverted.
    applyTickerMigration(db);
    expect(tickerRows().find((r) => r.symbol === "TEST")?.parent_symbol).not.toBe("BRANCH");
  });
});

describe("repairing thread ownership", () => {
  it("re-roots a ticker claimed in a reply onto its own thread", () => {
    applyTickerMigration(db);
    const branch = tickerRows().find((r) => r.symbol === "BRANCH");
    expect(branch?.root_id).toBe(2); // its own post, not the enclosing thread
  });

  it("moves the claiming post to root itself, keeping its lineage", () => {
    applyTickerMigration(db);
    const post = db.prepare("SELECT parent_id, root_id FROM posts WHERE id = 2").get() as {
      parent_id: number;
      root_id: number;
    };
    expect(post.root_id).toBe(2); // thread membership moved
    expect(post.parent_id).toBe(1); // lineage preserved — we still know where it branched
  });

  it("leaves a ticker claimed at a root post alone", () => {
    applyTickerMigration(db);
    expect(tickerRows().find((r) => r.symbol === "TEST")?.root_id).toBe(1);
    const post = db.prepare("SELECT root_id FROM posts WHERE id = 1").get() as { root_id: number };
    expect(post.root_id).toBe(1);
  });
});

describe("idempotency", () => {
  it("is stable across repeated runs", () => {
    applyTickerMigration(db);
    const first = tickerRows();
    applyTickerMigration(db);
    applyTickerMigration(db);
    expect(tickerRows()).toEqual(first);
  });

  it("does nothing when there are no tickers", () => {
    const fresh = new Database(":memory:");
    seedBrokenState(fresh);
    expect(() => applyTickerMigration(fresh)).not.toThrow();
    expect(fresh.prepare("SELECT COUNT(*) n FROM tickers").get()).toEqual({ n: 0 });
  });
});
