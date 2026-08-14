/**
 * What an author holds in a thread, through the real `createPost` path.
 *
 * The numbers here are the ones the wallet panel and the thread header put in
 * front of a user, so they are asserted against threads built the way the app
 * builds them — claims that re-root, replies that do not — rather than against
 * hand-inserted rows that could satisfy the query while contradicting how posts
 * actually land.
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
      ["x-forwarded-for", "10.0.0.12"],
      ["x-real-ip", "10.0.0.12"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { ROOT_TICKER } from "@/lib/ticker";
import { createPost, getHoldings, getThreadShare } from "./actions";

/** A stable author, so several posts attribute to the same holder. */
function author(name: string) {
  const key = PrivateKey.fromRandom();
  const pubkey = key.toPublicKey().toString();
  return {
    pubkey,
    async post(content: string, parentId?: number) {
      const fd = new FormData();
      fd.set("content", content);
      fd.set("author", name);
      fd.set("pubkey", pubkey);
      fd.set(
        "signature",
        key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
      );
      if (parentId !== undefined) fd.set("parent_id", String(parentId));
      const res = await createPost(fd);
      if (!res.ok) throw new Error(`post rejected: ${JSON.stringify(res)}`);
      return res;
    },
  };
}

const lastId = () => (db.prepare("SELECT MAX(id) as id FROM posts").get() as { id: number }).id;

beforeEach(() => {
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("getThreadShare", () => {
  it("counts the whole thread, not just the asker's posts", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");
    await alice.post("root of the thread");
    const root = lastId();
    await bob.post("a reply", root);
    await bob.post("another reply", root);

    expect(await getThreadShare(root, alice.pubkey)).toEqual({ mine: 1, total: 3 });
    expect(await getThreadShare(root, bob.pubkey)).toEqual({ mine: 2, total: 3 });
  });

  it("reports zero for someone who never posted in the thread", async () => {
    const alice = author("anon_alic");
    const stranger = author("anon_strg");
    await alice.post("root");
    const root = lastId();

    // `mine: 0` with a real `total` — not an empty thread. The header uses this
    // to decide whether to show a share at all.
    expect(await getThreadShare(root, stranger.pubkey)).toEqual({ mine: 0, total: 1 });
  });

  it("refuses junk input instead of returning a share of nothing", async () => {
    expect(await getThreadShare(0, "abc")).toEqual({ mine: 0, total: 0 });
    expect(await getThreadShare(-1, "abc")).toEqual({ mine: 0, total: 0 });
    expect(await getThreadShare(1, "")).toEqual({ mine: 0, total: 0 });
  });
});

describe("getHoldings", () => {
  it("lists every thread the author appears in, largest holding first", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");

    await alice.post("first thread");
    const t1 = lastId();
    await alice.post("me again", t1);
    await bob.post("bob here", t1);

    await bob.post("second thread");
    const t2 = lastId();
    await alice.post("alice drops in", t2);

    const held = await getHoldings(alice.pubkey);
    expect(held.map((h) => h.root_id)).toEqual([t1, t2]);
    expect(held[0]).toMatchObject({ root_id: t1, mine: 2, total: 3 });
    expect(held[1]).toMatchObject({ root_id: t2, mine: 1, total: 2 });
  });

  it("omits threads the author never posted in", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");
    await alice.post("alice's thread");
    await bob.post("bob's thread");

    const held = await getHoldings(alice.pubkey);
    expect(held).toHaveLength(1);
  });

  it("names a thread by its ticker ancestry", async () => {
    const alice = author("anon_alic");
    // A claim re-roots its post into its own thread, so $Child is a thread of
    // its own whose path still reads through its parent. Ancestry follows the
    // POST PARENT CHAIN, so $Child has to be written INSIDE $Parent's thread —
    // two sibling root posts would both hang off the root token instead, which
    // is what an earlier version of this test got wrong.
    await alice.post("starting $Parent");
    const parentRoot = lastId();
    await alice.post("branching into $Child", parentRoot);

    const held = await getHoldings(alice.pubkey);
    const child = held.find((h) => h.path.at(-1) === "CHILD");
    expect(child).toBeDefined();
    expect(child?.path).toEqual([ROOT_TICKER, "PARENT", "CHILD"]);
  });

  it("hangs an unparented claim off the root token", async () => {
    const alice = author("anon_alic");
    // Two sibling root posts: $Loose is not written inside $Other's thread, so
    // its only ancestor is the root token. Pinned because this is the case the
    // test above originally confused with real nesting.
    await alice.post("one idea, $Other");
    await alice.post("an unrelated idea, $Loose");

    const held = await getHoldings(alice.pubkey);
    const loose = held.find((h) => h.path.at(-1) === "LOOSE");
    expect(loose?.path).toEqual([ROOT_TICKER, "LOOSE"]);
  });

  it("still reports an unnamed thread, with an empty path", async () => {
    const alice = author("anon_alic");
    await alice.post("no ticker anywhere in this one");

    const held = await getHoldings(alice.pubkey);
    expect(held).toHaveLength(1);
    expect(held[0].path).toEqual([]);
    expect(held[0]).toMatchObject({ mine: 1, total: 1 });
  });

  it("returns nothing for an empty or missing pubkey", async () => {
    const alice = author("anon_alic");
    await alice.post("something");
    expect(await getHoldings("")).toEqual([]);
  });
});
