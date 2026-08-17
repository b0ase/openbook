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
import { creditUnits } from "@/lib/holdings";
import { enterRoom, roomTickerFor } from "@/lib/room-access";
import {
  createPost,
  getHoldings,
  getThreadShare,
  getTickerLeaderboard,
  getTickerSupply,
} from "./actions";

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
      /**
       * ⚠ WALK THROUGH THE DOOR FIRST. Entry burns a ticket and holding one is no
       * longer access (owner, 2026-08-17: "tickets are BURNED on entry, period"),
       * so a reply into a claimed thread needs a membership — including for the
       * founder, who has no exemption. These tests are about HOLDINGS, not the
       * gate; this is the fixture doing what a real user does at the door.
       */
      if (parentId !== undefined) {
        const rootId = (
          db.prepare("SELECT COALESCE(root_id, id) AS r FROM posts WHERE id = ?").get(parentId) as
            | { r: number }
            | undefined
        )?.r;
        const symbol = rootId ? roomTickerFor(rootId) : null;
        if (symbol) enterRoom(symbol, pubkey, { burnTxid: "fixture", paidSats: 0 });
      }
      const res = await createPost(fd);
      if (!res.ok) throw new Error(`post rejected: ${JSON.stringify(res)}`);
      return res;
    },
  };
}

const lastId = () => (db.prepare("SELECT MAX(id) as id FROM posts").get() as { id: number }).id;

beforeEach(() => {
  // The ownership ledger accumulates across tests exactly like the tables
  // beside it — a mint credits it, so it has to be reset with them.
  db.exec("DELETE FROM ticker_holdings");
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
  /**
   * ⚠ SUPERSEDED SEMANTICS. This used to aggregate THREAD MEMBERSHIP (`root_id`),
   * which is why the wallet and the feed printed different percentages for the
   * same ticker: a claim re-roots its post, so only the first post to name a
   * ticker joins that ticker's thread while every later mention stays its own
   * root. Named holdings now count MENTIONS — the denominator the feed and
   * /tickers already use — and an unnamed post is reported as the 1-of-1 it is
   * rather than as "100%" of a thread of one.
   */
  it("reports every unnamed post as a 1-of-1 post token, replies included", async () => {
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
    // Her three posts — the root, her reply in her own thread, and her reply in
    // bob's. Bob's two posts are his tokens, not hers.
    expect(held).toHaveLength(3);
    expect(held.every((h) => h.kind === "post")).toBe(true);
    expect(held.every((h) => h.mine === 1 && h.total === 1)).toBe(true);
    expect(held.map((h) => h.excerpt)).toEqual(["alice drops in", "me again", "first thread"]);
    expect(held.map((h) => h.root_id)).not.toContain(t2); // bob wrote that one
  });

  it("omits posts the author did not write", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");
    await alice.post("alice's thread");
    await bob.post("bob's thread");

    const held = await getHoldings(alice.pubkey);
    expect(held).toHaveLength(1);
  });

  it("counts a named holding by MENTIONS, so the wallet agrees with the feed", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");

    // Four posts name $MEMEPLEX. Only the first joins its thread (a claim
    // re-roots), so thread membership would have said 1-of-1 = 100% while the
    // feed printed 25% per unit off four mentions.
    await alice.post("$Memeplex");
    await alice.post("$Memeplex again");
    await alice.post("$Memeplex once more");
    await bob.post("$Memeplex from bob");

    const held = await getHoldings(alice.pubkey);
    const meme = held.find((h) => h.path.at(-1) === "MEMEPLEX");
    expect(meme).toMatchObject({ kind: "name", mine: 3, total: 4 });

    // The exact figure the feed derives for one unit of the same ticker.
    expect((await getTickerSupply(["MEMEPLEX"])).MEMEPLEX).toBe(4);
  });

  it("marks a truncated excerpt as cut, and does not end it mid-word", async () => {
    const alice = author("anon_alic");
    const long =
      "Payment fanouts cannot be infinite because the payments would be swallowed entirely by transaction fees";
    await alice.post(long);

    const [held] = await getHoldings(alice.pubkey);
    const excerpt = held.excerpt as string;
    // Without the marker a cut line just stops and reads as corrupted text.
    expect(excerpt.endsWith("\u2026")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(81);
    // Cut on a word boundary — the character before the ellipsis is not mid-word.
    expect(long.startsWith(excerpt.slice(0, -1))).toBe(true);
    expect(excerpt).not.toMatch(/\s\u2026$/);
  });

  it("leaves a short post's excerpt alone", async () => {
    const alice = author("anon_alic");
    await alice.post("short one");
    const [held] = await getHoldings(alice.pubkey);
    expect(held.excerpt).toBe("short one");
  });

  it("does not list a post twice — once as a post and once under the name it gave", async () => {
    const alice = author("anon_alic");
    await alice.post("naming $Solo here");

    const held = await getHoldings(alice.pubkey);
    expect(held).toHaveLength(1);
    expect(held[0].kind).toBe("name");
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
    expect(child?.path).toEqual(["PARENT", "CHILD"]);
  });

  it("leaves an unparented claim TOP-LEVEL, with no root prefix", async () => {
    const alice = author("anon_alic");
    // Two sibling root posts: $Loose is not written inside $Other's thread, so
    // it has no ancestor at all. Pinned because this is the case the test above
    // originally confused with real nesting — and because it used to be given
    // the root as a parent, a prefix every top-level token shared and which
    // therefore distinguished none of them.
    await alice.post("one idea, $Other");
    await alice.post("an unrelated idea, $Loose");

    const held = await getHoldings(alice.pubkey);
    const loose = held.find((h) => h.path.at(-1) === "LOOSE");
    expect(loose?.path).toEqual(["LOOSE"]);
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

/**
 * The leaderboard is the PAYOUT ROSTER — the same query a top-100 split will run
 * (DECISIONS.md). These pin the parts that would silently misreport money:
 * ordering, the denominator, and unattributed units.
 */
describe("getTickerLeaderboard", () => {
  it("ranks holders by units, largest first, over the full supply", async () => {
    const alice = author("anon_alic");
    const bob = author("anon_bobb");

    await alice.post("$Memeplex");
    await alice.post("$Memeplex again");
    await alice.post("$Memeplex once more");
    await bob.post("$Memeplex from bob");

    const board = await getTickerLeaderboard("MEMEPLEX");
    expect(board).not.toBeNull();
    expect(board?.total).toBe(4);
    expect(board?.attributed).toBe(4);
    expect(board?.holders.map((h) => h.units)).toEqual([3, 1]);
    expect(board?.holders[0].pubkey).toBe(alice.pubkey);
    // The denominator is the whole supply, so shares across holders sum to 100%.
    expect(board?.holders.reduce((n, h) => n + h.units, 0)).toBe(board?.total);
  });

  it("REPORTS units that have no owner rather than dropping them", async () => {
    const alice = author("anon_alic");
    await alice.post("$Orphan");
    // A genesis-style post: operator-attested, no pubkey. Its unit is real and
    // counts toward supply, but there is nobody to credit it to. Dropping it
    // would make the listed shares fail to reach 100% with no explanation.
    const id = db
      .prepare("INSERT INTO posts (content, author_name) VALUES ('$Orphan too', 'anon_gen1')")
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO ticker_mentions (symbol, post_id, target_type) VALUES ('ORPHAN', ?, 'none')"
    ).run(id);
    // Unowned units live in the ledger under the empty pubkey — see holdings.ts.
    creditUnits("ORPHAN", "", 1);

    const board = await getTickerLeaderboard("ORPHAN");
    expect(board?.total).toBe(2);
    expect(board?.attributed).toBe(1);
    expect(board?.holders).toHaveLength(1);
  });

  it("carries the ticker's ancestry so the page can link back to its thread", async () => {
    const alice = author("anon_alic");
    await alice.post("starting $Parent");
    const parentRoot = lastId();
    await alice.post("branching into $Child", parentRoot);

    const board = await getTickerLeaderboard("CHILD");
    expect(board?.path).toEqual(["PARENT", "CHILD"]);
  });

  it("returns null for a name nobody has written — not an empty board", async () => {
    // The page 404s on null. An empty leaderboard would imply the token exists.
    expect(await getTickerLeaderboard("NEVERWRITTEN")).toBeNull();
    expect(await getTickerLeaderboard("not a ticker")).toBeNull();
  });
});
