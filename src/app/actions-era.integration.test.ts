/**
 * The fork boundary as a FEED RULE, not just a label.
 *
 * Posts up to `FORK_POINT_ID` were written on OpenCook by other people. They are
 * reproduced here faithfully — the fork is only checkable if the shared history
 * is actually present — but they must not appear in this board's feed as though
 * they were said here. These tests pin the default (hidden) and the opt-in
 * (shown), because the failure mode is silent: a regression would simply start
 * presenting other people's posts as ours, and nothing would error.
 */

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

import { db } from "@/lib/db";
import { FORK_POINT_ID } from "@/lib/fork-point";
import { getForwardPosts, getOlderPosts, getOldestPosts, getPosts } from "./actions";

/** Insert directly at a chosen id — the only way to fabricate inherited history. */
function seedAt(id: number, content: string) {
  db.prepare(
    "INSERT INTO posts (id, content, author_name, pubkey, parent_id, root_id) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run(id, content, "anon_seed", "02deadbeef", id);
}

beforeEach(() => {
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
});

describe("the feed hides the inherited OpenCook run-up by default", () => {
  beforeEach(() => {
    seedAt(FORK_POINT_ID - 2, "written on OpenCook");
    seedAt(FORK_POINT_ID - 1, "also OpenCook");
    seedAt(FORK_POINT_ID, "the fork announcement — still theirs");
    seedAt(FORK_POINT_ID + 1, "OpenBook's own first post");
    seedAt(FORK_POINT_ID + 2, "and its second");
  });

  it("returns only OpenBook-era posts", async () => {
    const posts = await getPosts();
    expect(posts.map((p) => p.id)).toEqual([FORK_POINT_ID + 2, FORK_POINT_ID + 1]);
  });

  it("treats the fork post itself as inherited — it was written on OpenCook", async () => {
    // FORK_POINT_ID is the post that ANNOUNCED the fork, made upstream. The
    // boundary is `> FORK_POINT_ID`, not `>=`.
    const ids = (await getPosts()).map((p) => p.id);
    expect(ids).not.toContain(FORK_POINT_ID);
  });

  it("includes the run-up when explicitly asked", async () => {
    const posts = await getPosts(undefined, true);
    expect(posts).toHaveLength(5);
    expect(posts.map((p) => p.id)).toContain(FORK_POINT_ID - 2);
  });

  it("stops scrolling up at the fork rather than running into someone else's board", async () => {
    // The upward-scroll cursor sits at OpenBook's oldest post; the next page must
    // come back empty, which is what closes the feed's `liveHasMore`.
    expect(await getOlderPosts(FORK_POINT_ID + 1)).toEqual([]);
    // ...and non-empty once the reader opts in.
    expect((await getOlderPosts(FORK_POINT_ID + 1, true)).length).toBe(3);
  });

  it("jumps ORIGIN to OpenBook's genesis, not to post #1 of OpenCook", async () => {
    const oldest = await getOldestPosts();
    expect(oldest[0]?.id).toBe(FORK_POINT_ID + 1);
    // Opting in reaches back to the true beginning of the shared history.
    expect((await getOldestPosts(true))[0]?.id).toBe(FORK_POINT_ID - 2);
  });

  it("reads forward without silently re-admitting inherited posts", async () => {
    const fwd = await getForwardPosts(0);
    expect(fwd.every((p) => p.id > FORK_POINT_ID)).toBe(true);
    expect((await getForwardPosts(0, true)).length).toBe(5);
  });
});
