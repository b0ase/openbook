/**
 * Threading write + read paths (THREADS.md steps 2–3).
 *
 * Uses the in-memory SQLite singleton (DATABASE_PATH=':memory:' from
 * integration-setup.ts) so the real migrations run, and signs with real BSV keys
 * so createPost's signature check is genuinely exercised rather than bypassed.
 */

import { PrivateKey } from "@bsv/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/bsv/onchain", () => ({
  logPostOnChain: vi.fn().mockResolvedValue("mocktxid_post"),
}));
vi.mock("@/services/bsv/anchor-sweep", () => ({
  sweepOrphans: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/link-unfurl", () => ({
  // No outbound fetches from a test suite.
  unfurl: vi.fn().mockResolvedValue({ ok: false, url: "", reason: "fetch_failed" }),
}));
vi.mock("@/services/bsv/wallet", () => ({
  isServerSpendDisabled: vi.fn().mockReturnValue(false),
  getServerAddress: vi.fn().mockReturnValue("1PlatformAddressForTests"),
  getBalance: vi.fn().mockResolvedValue(500_000),
  buildAndBroadcast: vi.fn(),
  SERVER_FEE_BUFFER_SATS: 300,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(
    new Map([
      ["x-forwarded-for", "10.0.0.9"],
      ["x-real-ip", "10.0.0.9"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { createPost, getNewPosts, getPosts, getThread } from "./actions";

async function post(content: string, parentId?: number) {
  const key = PrivateKey.fromRandom();
  const messageBytes = Array.from(new TextEncoder().encode(content));
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_t3st");
  fd.set("pubkey", key.toPublicKey().toString());
  fd.set("signature", key.sign(messageBytes).toDER("hex") as string);
  if (parentId !== undefined) fd.set("parent_id", String(parentId));
  const result = await createPost(fd);
  return result;
}

function lastId(): number {
  return (db.prepare("SELECT MAX(id) as id FROM posts").get() as { id: number }).id;
}

function rowOf(id: number) {
  return db.prepare("SELECT id, parent_id, root_id FROM posts WHERE id = ?").get(id) as {
    id: number;
    parent_id: number | null;
    root_id: number | null;
  };
}

beforeEach(() => {
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("createPost — thread roots", () => {
  it("a post with no parent is its own root", () => {
    return post("a new thread").then((r) => {
      expect(r.ok).toBe(true);
      const row = rowOf(lastId());
      expect(row.parent_id).toBeNull();
      expect(row.root_id).toBe(row.id); // self-rooted
    });
  });
});

describe("createPost — replies", () => {
  it("a reply carries its parent and the thread root", async () => {
    await post("root post");
    const rootId = lastId();

    expect((await post("a reply", rootId)).ok).toBe(true);
    const reply = rowOf(lastId());

    expect(reply.parent_id).toBe(rootId);
    expect(reply.root_id).toBe(rootId);
  });

  it("a nested reply keeps the ORIGINAL root, not its immediate parent", async () => {
    // ⚠ THE POINT OF root_id. Without this, "every post in this thread" needs a
    // recursive walk instead of one indexed lookup — and that query sits on the
    // token-allocation path.
    await post("root");
    const rootId = lastId();
    await post("depth 1", rootId);
    const depth1 = lastId();
    await post("depth 2", depth1);
    const depth2 = lastId();
    await post("depth 3", depth2);
    const depth3 = lastId();

    expect(rowOf(depth3).parent_id).toBe(depth2); // parent is immediate
    expect(rowOf(depth3).root_id).toBe(rootId); // root is the thread's first post
    expect(rowOf(depth2).root_id).toBe(rootId);
  });

  it("REFUSES a reply to a post that does not exist", async () => {
    // An orphan would be unrenderable: excluded from the feed for having a
    // parent, and absent from every thread for pointing at a root that isn't there.
    const r = await post("orphan", 999_999);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_parent");
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 0 });
  });

  it.each([
    ["0"],
    ["-1"],
    ["abc"],
    ["1.5"],
    ["1e3"],
  ])("refuses a malformed parent_id %j", async (raw) => {
    const key = PrivateKey.fromRandom();
    const fd = new FormData();
    fd.set("content", "bad parent");
    fd.set("author", "anon_t3st");
    fd.set("pubkey", key.toPublicKey().toString());
    fd.set(
      "signature",
      key.sign(Array.from(new TextEncoder().encode("bad parent"))).toDER("hex") as string
    );
    fd.set("parent_id", raw);

    const r = await createPost(fd);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_parent");
  });

  it("treats an empty parent_id as no parent, not as invalid", async () => {
    // A form that always sets the field would otherwise be unable to post a root.
    const key = PrivateKey.fromRandom();
    const fd = new FormData();
    fd.set("content", "empty parent field");
    fd.set("author", "anon_t3st");
    fd.set("pubkey", key.toPublicKey().toString());
    fd.set(
      "signature",
      key.sign(Array.from(new TextEncoder().encode("empty parent field"))).toDER("hex") as string
    );
    fd.set("parent_id", "");

    expect((await createPost(fd)).ok).toBe(true);
    const row = rowOf(lastId());
    expect(row.parent_id).toBeNull();
    expect(row.root_id).toBe(row.id);
  });
});

describe("the feed shows roots only", () => {
  it("excludes replies from getPosts", async () => {
    await post("visible root");
    const rootId = lastId();
    await post("hidden reply", rootId);

    const feed = await getPosts();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe(rootId);
  });

  it("excludes replies from getNewPosts — the 5s poll", async () => {
    // ⚠ The worst place to leak a reply: this is polled continuously, so one
    // would pop into every open feed live.
    await post("root");
    const rootId = lastId();
    const since = rootId;
    await post("reply", rootId);
    await post("another root");

    const fresh = await getNewPosts(since);
    expect(fresh.every((p) => p.parent_id === null)).toBe(true);
    expect(fresh).toHaveLength(1);
  });

  it("still returns every root", async () => {
    await post("one");
    await post("two");
    await post("three");
    expect(await getPosts()).toHaveLength(3);
  });
});

describe("getThread", () => {
  it("returns the root first, then replies in order", async () => {
    await post("the root");
    const rootId = lastId();
    await post("first reply", rootId);
    await post("second reply", rootId);

    const thread = await getThread(rootId);
    expect(thread).toHaveLength(3);
    expect(thread[0].id).toBe(rootId); // the root is included
    expect(thread.map((p) => p.content)).toEqual(["the root", "first reply", "second reply"]);
  });

  it("includes nested replies at any depth", async () => {
    await post("root");
    const rootId = lastId();
    await post("d1", rootId);
    await post("d2", lastId());

    expect(await getThread(rootId)).toHaveLength(3);
  });

  it("does not leak other threads", async () => {
    await post("thread A");
    const a = lastId();
    await post("reply to A", a);
    await post("thread B");
    const b = lastId();
    await post("reply to B", b);

    expect((await getThread(a)).map((p) => p.content)).toEqual(["thread A", "reply to A"]);
    expect((await getThread(b)).map((p) => p.content)).toEqual(["thread B", "reply to B"]);
  });

  it("returns empty for a nonexistent or invalid id", async () => {
    expect(await getThread(999_999)).toEqual([]);
    expect(await getThread(0)).toEqual([]);
    expect(await getThread(-1)).toEqual([]);
  });
});

describe("reply_count on the feed row", () => {
  it("counts replies, excluding the root itself", async () => {
    // A thread with no replies must read 0, not 1 — the root is not its own reply.
    await post("lonely root");
    const lonely = lastId();
    await post("busy root");
    const busy = lastId();
    await post("r1", busy);
    await post("r2", busy);

    const feed = await getPosts();
    const byId = Object.fromEntries(feed.map((p) => [p.id, p.reply_count]));
    expect(byId[busy]).toBe(2);
    expect(byId[lonely]).toBe(0);
  });

  it("counts nested replies, not just direct ones", async () => {
    // reply_count keys on root_id, so a reply five levels down still counts
    // toward the thread it belongs to.
    await post("root");
    const rootId = lastId();
    await post("d1", rootId);
    await post("d2", lastId());

    const feed = await getPosts();
    expect(feed.find((p) => p.id === rootId)?.reply_count).toBe(2);
  });

  it("rides along with the feed query — no second round-trip", async () => {
    // The count comes from the POST_SELECT join, so it cannot drift from the
    // row it is rendered beside.
    await post("root");
    const rootId = lastId();
    await post("a reply", rootId);

    const fresh = await getNewPosts(rootId - 1);
    expect(fresh[0].reply_count).toBe(1);
  });
});
