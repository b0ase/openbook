/**
 * Ticker claiming through the real `createPost` path.
 *
 * The rule under test is FIRST CLAIM WINS, and it is enforced by the `tickers`
 * PRIMARY KEY rather than by application logic — so these tests exist to prove
 * the database actually holds that line, including when two posts claim the same
 * name and when the same name is written in different case.
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
      ["x-forwarded-for", "10.0.0.11"],
      ["x-real-ip", "10.0.0.11"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { createPost, getTickerPath, resolveTickers } from "./actions";

async function post(content: string, parentId?: number) {
  const key = PrivateKey.fromRandom();
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_t1ck");
  fd.set("pubkey", key.toPublicKey().toString());
  fd.set(
    "signature",
    key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
  );
  if (parentId !== undefined) fd.set("parent_id", String(parentId));
  return createPost(fd);
}

const lastId = () => (db.prepare("SELECT MAX(id) as id FROM posts").get() as { id: number }).id;

beforeEach(() => {
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("claiming", () => {
  it("registers a ticker written in a post", async () => {
    expect((await post("starting $NewIdea here")).ok).toBe(true);
    const id = lastId();
    expect(await resolveTickers(["NEWIDEA"])).toEqual({ NEWIDEA: { root_id: id, post_id: id } });
  });

  it("points at ITS OWN thread, not the one it was named in", async () => {
    // Superseded an earlier assertion that a ticker inherits the enclosing
    // thread's root. That was the bug: clicking the new ticker re-opened its
    // parent instead of the new idea. A claim re-roots its post, so the ticker
    // names a thread of its own.
    await post("root of the thread");
    const rootId = lastId();
    await post("and I name it $Branch", rootId);
    const replyId = lastId();

    const resolved = await resolveTickers(["BRANCH"]);
    expect(resolved.BRANCH).toEqual({ root_id: replyId, post_id: replyId });
    expect(resolved.BRANCH.root_id).not.toBe(rootId);
  });

  it("registers several distinct tickers from one post", async () => {
    await post("comparing $Alpha with $Beta");
    const resolved = await resolveTickers(["ALPHA", "BETA"]);
    expect(Object.keys(resolved).sort()).toEqual(["ALPHA", "BETA"]);
  });

  it("does NOT claim a price", async () => {
    // The expensive false positive: a claim the author never intended.
    await post("this costs $50 and $1.50");
    expect(await resolveTickers(["50", "1"])).toEqual({});
    expect(db.prepare("SELECT COUNT(*) n FROM tickers").get()).toEqual({ n: 0 });
  });
});

describe("first claim wins", () => {
  it("a later post does NOT take over an existing ticker", async () => {
    await post("I claim $Contested first");
    const firstId = lastId();
    await post("I also want $Contested");

    const resolved = await resolveTickers(["CONTESTED"]);
    expect(resolved.CONTESTED.post_id).toBe(firstId);
    expect(db.prepare("SELECT COUNT(*) n FROM tickers").get()).toEqual({ n: 1 });
  });

  it("treats different casing as the SAME claim", async () => {
    // Otherwise `$openbook` is a second, visually identical claim on `$OpenBook`
    // — the impersonation vector the canonical form exists to close.
    await post("mine: $OpenBook");
    const firstId = lastId();
    await post("mine too: $OPENBOOK and $openbook");

    const resolved = await resolveTickers(["OPENBOOK"]);
    expect(resolved.OPENBOOK.post_id).toBe(firstId);
    expect(db.prepare("SELECT COUNT(*) n FROM tickers").get()).toEqual({ n: 1 });
  });

  it("counts one claim when a post repeats the same ticker", async () => {
    await post("$Echo $Echo $echo");
    expect(db.prepare("SELECT COUNT(*) n FROM tickers").get()).toEqual({ n: 1 });
  });
});

describe("resolveTickers", () => {
  it("omits unclaimed symbols rather than inventing them", async () => {
    expect(await resolveTickers(["NOBODYHASTHIS"])).toEqual({});
  });

  it("ignores malformed input without touching the database", async () => {
    expect(await resolveTickers(["not valid", "", "3BAD"])).toEqual({});
  });

  it("returns an empty map for no input", async () => {
    expect(await resolveTickers([])).toEqual({});
  });
});

describe("a failed post claims nothing", () => {
  it("does not register tickers for a rejected post", async () => {
    // Registration must sit AFTER the insert — a refused post that still claimed
    // a name would let anyone squat every ticker for free.
    const key = PrivateKey.fromRandom();
    const fd = new FormData();
    fd.set("content", "$Squatted");
    fd.set("author", "anon_t1ck");
    fd.set("pubkey", key.toPublicKey().toString());
    fd.set("signature", "not-a-real-signature");

    expect((await createPost(fd)).ok).toBe(false);
    expect(await resolveTickers(["SQUATTED"])).toEqual({});
  });
});

describe("a new ticker starts its OWN thread", () => {
  it("does NOT point back at the thread it was named in", async () => {
    // The bug this pins: a ticker claimed inside a thread used to inherit that
    // thread's root, so clicking it re-opened the parent instead of opening the
    // new idea.
    await post("root of $Alpha");
    const alphaRoot = lastId();
    await post("branching into $Bravo here", alphaRoot);
    const bravoPost = lastId();

    const r = await resolveTickers(["ALPHA", "BRAVO"]);
    expect(r.ALPHA.root_id).toBe(alphaRoot);
    expect(r.BRAVO.root_id).toBe(bravoPost); // its own thread, not alphaRoot
    expect(r.BRAVO.root_id).not.toBe(alphaRoot);
  });

  it("re-roots the claiming post so thread reads separate the two", async () => {
    await post("root of $Charlie");
    const charlieRoot = lastId();
    await post("and now $Delta", charlieRoot);
    const deltaPost = lastId();

    const row = db.prepare("SELECT parent_id, root_id FROM posts WHERE id = ?").get(deltaPost) as {
      parent_id: number;
      root_id: number;
    };
    // Lineage preserved, thread membership moved.
    expect(row.parent_id).toBe(charlieRoot);
    expect(row.root_id).toBe(deltaPost);
  });

  it("does NOT re-root when the ticker was already claimed", async () => {
    await post("first claim of $Echo");
    await post("plain root");
    const otherRoot = lastId();
    await post("citing $Echo again", otherRoot);
    const citingPost = lastId();

    const row = db.prepare("SELECT root_id FROM posts WHERE id = ?").get(citingPost) as {
      root_id: number;
    };
    expect(row.root_id).toBe(otherRoot); // a citation is not a claim
  });
});

describe("the tree is the right way round", () => {
  it("builds $OpenBook/$Parent/$Child, not the reverse", async () => {
    // The reported bug was `$branch/$test` — the tree upside down — because the
    // parent was inferred without requiring it to have been claimed EARLIER.
    await post("starting $Foxtrot");
    const foxRoot = lastId();
    await post("inside it, $Golf", foxRoot);

    expect(await getTickerPath("GOLF")).toEqual(["OPENBOOK", "FOXTROT", "GOLF"]);
    expect(await getTickerPath("FOXTROT")).toEqual(["OPENBOOK", "FOXTROT"]);
  });

  it("parents a top-level claim to the root token", async () => {
    await post("just $Hotel on its own");
    expect(await getTickerPath("HOTEL")).toEqual(["OPENBOOK", "HOTEL"]);
  });
});
