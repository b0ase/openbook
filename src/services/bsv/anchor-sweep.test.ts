import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logPostOnChain = vi.fn();
vi.mock("./onchain", () => ({
  logPostOnChain: (...args: unknown[]) => logPostOnChain(...args),
}));

import { sweepOrphans } from "./anchor-sweep";

/**
 * ⚠ This fixture DUPLICATES the real schema rather than running the migrations,
 * so it drifts silently: when the sweep started selecting `parent_id`, the query
 * threw, `sweepOrphans` swallowed it, and the "leaves the post pending" test
 * still passed — because a post that was never read also never gets a tx_id.
 * Keep the columns the sweep reads in sync here, or prefer the migration-backed
 * `anchor-sweep-roundtrip.integration.test.ts` for new cases.
 */
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    author_name TEXT NOT NULL,
    signature TEXT,
    pubkey TEXT,
    tx_id TEXT,
    parent_id INTEGER REFERENCES posts(id),
    root_id INTEGER REFERENCES posts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe("sweepOrphans", () => {
  beforeEach(() => logPostOnChain.mockReset());

  it("anchors an un-anchored post old enough to have finished its inline attempt", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO posts (content, author_name, signature, pubkey, created_at) VALUES (?,?,?,?, datetime('now','-5 minutes'))"
    ).run("hello", "anon_aaaa", "sig", "pk");
    logPostOnChain.mockResolvedValue("txid_abc");

    await sweepOrphans(db as unknown as ReturnType<typeof Database>);

    expect(logPostOnChain).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = 1").get() as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBe("txid_abc");
  });

  it("does NOT sweep a too-fresh post (its inline attempt may still be running)", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO posts (content, author_name, signature, pubkey) VALUES (?,?,?,?)").run(
      "fresh",
      "anon_bbbb",
      "sig",
      "pk"
    ); // created_at = now → inside the 90s min-age window

    await sweepOrphans(db as unknown as ReturnType<typeof Database>);

    expect(logPostOnChain).not.toHaveBeenCalled();
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = 1").get() as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBeNull();
  });

  it("leaves the post pending (NULL) on broadcast failure — never gives up", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO posts (content, author_name, signature, pubkey, created_at) VALUES (?,?,?,?, datetime('now','-5 minutes'))"
    ).run("retry", "anon_cccc", "sig", "pk");
    logPostOnChain.mockResolvedValue(null); // broadcast failed (dry wallet / ARC down)

    await sweepOrphans(db as unknown as ReturnType<typeof Database>);

    const row = db.prepare("SELECT tx_id FROM posts WHERE id = 1").get() as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBeNull(); // still queued for a later sweep
  });
});
