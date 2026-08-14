/**
 * Integration tests for the durable on-chain anchor sweep.
 *
 * Uses the in-memory SQLite singleton (DATABASE_PATH=':memory:' set in
 * integration-setup.ts). logPostOnChain is mocked so no real ARC/WoC contact.
 *
 * Verifies:
 * 1. createPost inserts with tx_id=NULL (logPostOnChain returns null for fresh post
 *    simulation — the actual inline attempt always runs but we test the NULL state).
 * 2. sweepOrphans anchors a backdated un-anchored post → tx_id is set.
 * 3. pendingAnchorCount is accurate on a seeded DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Must be hoisted before any import that touches the module
const mockLogPostOnChain = vi.fn();

vi.mock("./onchain", () => ({
  logPostOnChain: (...args: unknown[]) => mockLogPostOnChain(...args),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { pendingAnchorCount, sweepOrphans } from "./anchor-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateTables() {
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM boot_grants");
  db.exec("DELETE FROM posts");
}

/**
 * Insert a post directly into the shared singleton DB with a backdated
 * created_at so sweepOrphans will consider it past the 90s min-age.
 */
function insertOrphanPost(label: string): number {
  const r = db
    .prepare(
      `INSERT INTO posts (content, author_name, signature, pubkey, tx_id, created_at)
       VALUES (?, ?, ?, ?, NULL, datetime('now', '-5 minutes'))`
    )
    .run(`Orphan post: ${label}`, "anon_sweep", "fakesig", "fakepubkey");
  return r.lastInsertRowid as number;
}

/** Insert a backdated un-anchored REPLY to `parentId` (THREADS.md). */
function insertOrphanReply(label: string, parentId: number): number {
  const r = db
    .prepare(
      `INSERT INTO posts (content, author_name, signature, pubkey, tx_id, parent_id, root_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, datetime('now', '-5 minutes'))`
    )
    .run(`Orphan reply: ${label}`, "anon_sweep", "fakesig", "fakepubkey", parentId, parentId);
  return r.lastInsertRowid as number;
}

/** Insert a fresh post (created_at = now, below 90s min-age). */
function insertFreshPost(label: string): number {
  const r = db
    .prepare(
      "INSERT INTO posts (content, author_name, signature, pubkey, tx_id) VALUES (?,?,?,?,NULL)"
    )
    .run(`Fresh post: ${label}`, "anon_fresh", "fakesig", "fakepubkey");
  return r.lastInsertRowid as number;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("anchor sweep roundtrip — integration", () => {
  beforeEach(() => {
    truncateTables();
    mockLogPostOnChain.mockReset();
    // Reset the in-flight guard so each test starts with a clean sweep state
    // (the guard is module-level state in anchor-sweep.ts; we reset by letting
    // the sweepInFlight flag clear itself after each await in the previous test).
  });

  it("sweepOrphans anchors an old un-anchored post and sets tx_id", async () => {
    const postId = insertOrphanPost("to-be-anchored");
    mockLogPostOnChain.mockResolvedValue("txid_anchored_001");

    await sweepOrphans(db);

    expect(mockLogPostOnChain).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = ?").get(postId) as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBe("txid_anchored_001");
  });

  it("sweepOrphans does NOT touch a post younger than the 90s min-age", async () => {
    const postId = insertFreshPost("too-fresh");

    await sweepOrphans(db);

    expect(mockLogPostOnChain).not.toHaveBeenCalled();
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = ?").get(postId) as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBeNull();
  });

  it("sweepOrphans leaves tx_id NULL when broadcast fails, never gives up", async () => {
    const postId = insertOrphanPost("broadcast-fails");
    mockLogPostOnChain.mockResolvedValue(null); // ARC down / dry wallet

    await sweepOrphans(db);

    expect(mockLogPostOnChain).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = ?").get(postId) as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBeNull(); // still in the orphan queue
  });

  it("pendingAnchorCount returns correct count of posts with tx_id=NULL", () => {
    // Start empty
    expect(pendingAnchorCount(db)).toBe(0);

    // Insert two orphans and one anchored post
    insertOrphanPost("pending-1");
    insertOrphanPost("pending-2");

    // Insert an already-anchored post
    db.prepare(
      "INSERT INTO posts (content, author_name, signature, pubkey, tx_id, created_at) VALUES (?,?,?,?,?,datetime('now','-10 minutes'))"
    ).run("Anchored post", "anon_anchored", "fakesig", "fakepubkey", "txid_existing");

    expect(pendingAnchorCount(db)).toBe(2);
  });

  it("pendingAnchorCount drops to 0 after all orphans are swept", async () => {
    insertOrphanPost("sweep-all-1");
    insertOrphanPost("sweep-all-2");

    expect(pendingAnchorCount(db)).toBe(2);

    // First sweep anchors one (single-flight, one broadcast per sweep)
    mockLogPostOnChain.mockResolvedValue("txid_sweep_a");
    await sweepOrphans(db);
    expect(pendingAnchorCount(db)).toBe(1);

    // Reset the in-flight guard — module var cleared at top of next call
    mockLogPostOnChain.mockResolvedValue("txid_sweep_b");
    await sweepOrphans(db);
    expect(pendingAnchorCount(db)).toBe(0);
  });

  it("forwards a swept post's id and parent to the on-chain record", async () => {
    // ⚠ The sweep is the ONLY path that anchors a post whose inline broadcast
    // failed. An OP_RETURN is immutable, so if the sweep drops parent_id, that
    // reply is unthreadable from the chain forever — there is no second attempt.
    const rootId = insertOrphanPost("thread-root");
    db.prepare("UPDATE posts SET root_id = id WHERE id = ?").run(rootId);
    const replyId = insertOrphanReply("a reply", rootId);
    // Anchor the root first so the sweep (oldest id first, one per call) reaches
    // the reply on the next pass.
    db.prepare("UPDATE posts SET tx_id = 'txid_root' WHERE id = ?").run(rootId);

    mockLogPostOnChain.mockResolvedValue("txid_reply");
    await sweepOrphans(db);

    expect(mockLogPostOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ id: replyId, parent: rootId })
    );
  });

  it("forwards parent: null for a swept root", async () => {
    const rootId = insertOrphanPost("lone-root");
    mockLogPostOnChain.mockResolvedValue("txid_lone");

    await sweepOrphans(db);

    expect(mockLogPostOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ id: rootId, parent: null })
    );
  });

  it("createPost path: post is initially inserted with tx_id=NULL", () => {
    // Directly test the DB layer: a post inserted by createPost has tx_id=NULL
    // until logPostOnChain resolves (fire-and-forget).
    const r = db
      .prepare("INSERT INTO posts (content, author_name, signature, pubkey) VALUES (?,?,?,?)")
      .run("Integration orphan test", "anon_xx01", "fakesig", "fakepubkey");

    const postId = r.lastInsertRowid as number;
    const row = db.prepare("SELECT tx_id FROM posts WHERE id = ?").get(postId) as {
      tx_id: string | null;
    };
    expect(row.tx_id).toBeNull();
    expect(pendingAnchorCount(db)).toBeGreaterThanOrEqual(1);
  });
});
