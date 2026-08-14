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
import { ROOT_TICKER } from "@/lib/ticker";
import { createPost, getThread, getTickerPath, resolveTickers } from "./actions";

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
    // Otherwise `$sierra` is a second, visually identical claim on `$Sierra` —
    // the impersonation vector the canonical form exists to close.
    //
    // Uses an ordinary name rather than the root's: this is about case-folding,
    // and coupling it to whatever the root happens to be called meant renaming
    // the board broke a test that has nothing to do with the board's name.
    await post("mine: $Sierra");
    const firstId = lastId();
    await post("mine too: $SIERRA and $sierra");

    const resolved = await resolveTickers(["SIERRA"]);
    expect(resolved.SIERRA.post_id).toBe(firstId);
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

    expect(await getTickerPath("GOLF")).toEqual([ROOT_TICKER, "FOXTROT", "GOLF"]);
    expect(await getTickerPath("FOXTROT")).toEqual([ROOT_TICKER, "FOXTROT"]);
  });

  it("parents a top-level claim to the root token", async () => {
    await post("just $Hotel on its own");
    expect(await getTickerPath("HOTEL")).toEqual([ROOT_TICKER, "HOTEL"]);
  });
});

describe("branch points stay visible in the parent thread", () => {
  it("keeps the claiming post in the thread it branched off", async () => {
    // The regression this pins: re-rooting removed the post from its parent's
    // root_id set, so the branch point — and the $child link in it — vanished
    // from the conversation it came out of.
    await post("root of $India");
    const indiaRoot = lastId();
    await post("branching into $Juliet from here", indiaRoot);
    const branchPost = lastId();

    const parent = await getThread(indiaRoot);
    expect(parent.map((p) => p.id)).toContain(branchPost);
  });

  it("does not pull the branch's own replies into the parent", async () => {
    await post("root of $Kilo");
    const kiloRoot = lastId();
    await post("branching into $Lima", kiloRoot);
    const branchPost = lastId();
    await post("a reply inside the branch", branchPost);
    const deepReply = lastId();

    const parent = await getThread(kiloRoot);
    expect(parent.map((p) => p.id)).toContain(branchPost);
    expect(parent.map((p) => p.id)).not.toContain(deepReply);

    // And the child thread stands on its own.
    const child = await getThread(branchPost);
    expect(child.map((p) => p.id)).toEqual([branchPost, deepReply]);
  });

  it("does not duplicate ordinary replies", async () => {
    await post("root of $Mike");
    const mikeRoot = lastId();
    await post("just a normal reply", mikeRoot);

    const ids = (await getThread(mikeRoot)).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a repeat mention is an INVOCATION, not a claim", () => {
  // The owner's rule: "a duplicate ticker is only an invocation of the first
  // instance". First mention founds the token; every later one cites it. This is
  // enforced by `res.changes > 0` — `INSERT OR IGNORE` reports no change when the
  // name is taken, so `claimedAny` stays false and nothing is re-rooted.
  //
  // Under the settled citation model this second mention is exactly what would
  // mint the quoter a unit of the first post's token — once posting costs money.
  // See TOKENS.md; do not build that here.

  it("does not re-root the post that merely cites an existing ticker", async () => {
    expect((await post("founding $Branch")).ok).toBe(true);
    const founder = lastId();

    // A REPLY citing the same name. If a citation were treated as a claim, this
    // would be re-rooted to itself and silently leave the thread it was written
    // in — which is what "hoisted by the second instance" looks like.
    expect((await post("still talking about $Branch", founder)).ok).toBe(true);
    const citer = lastId();

    const row = db.prepare("SELECT root_id, parent_id FROM posts WHERE id = ?").get(citer) as {
      root_id: number;
      parent_id: number;
    };
    expect(row.root_id).toBe(founder);
    expect(row.parent_id).toBe(founder);
  });

  it("leaves the ticker pointing at its ORIGINAL post, not the citing one", async () => {
    await post("founding $Branch");
    const founder = lastId();
    await post("citing $Branch again", founder);

    expect(await resolveTickers(["BRANCH"])).toEqual({
      BRANCH: { root_id: founder, post_id: founder },
    });
  });

  it("does not deepen the path — a name cannot become a child of itself", async () => {
    // The reported symptom was a doubled segment, `$openbook/$test/$branch/$branch`.
    // It cannot exist: ticker names are GLOBALLY unique, so the path is a display
    // of ancestry, not a per-path namespace. There is only ever one $Branch.
    await post("founding $Branch");
    await post("citing $Branch");
    await post("citing $Branch a third time");

    const path = await getTickerPath("BRANCH");
    expect(path).toEqual([ROOT_TICKER, "BRANCH"]);
    expect(path.filter((s) => s === "BRANCH")).toHaveLength(1);
  });

  it("still claims a genuinely new name written alongside a cited one", async () => {
    await post("founding $Branch");
    const founder = lastId();
    // One name taken, one free — the free one must still be founded.
    expect((await post("$Branch leads to $Sprout", founder)).ok).toBe(true);
    const mixed = lastId();

    expect(await resolveTickers(["SPROUT"])).toEqual({
      SPROUT: { root_id: mixed, post_id: mixed },
    });
    // And that post DID claim, so it re-roots into its own thread.
    const row = db.prepare("SELECT root_id FROM posts WHERE id = ?").get(mixed) as {
      root_id: number;
    };
    expect(row.root_id).toBe(mixed);
  });
});

describe("the root ticker is claimable like any other", () => {
  // Nobody had claimed the board's own name, so `/$openbooks` was hard-coded to
  // mean "show the feed". That is only safe while it stays unclaimed: once it is
  // a real thread, `handleOpenTicker` pushes `/$openbooks` into the address bar
  // for a thread the URL handler would refuse to reopen — you would see one
  // thing and share another. These pin the resolution, which is what the URL
  // handler now depends on rather than a special case.

  it("registers the root name as a normal claim", async () => {
    expect((await post(`naming the board itself: $${ROOT_TICKER}`)).ok).toBe(true);
    const id = lastId();
    const resolved = await resolveTickers([ROOT_TICKER]);
    expect(resolved[ROOT_TICKER]).toEqual({ root_id: id, post_id: id });
  });

  it("gives the root no parent, so the tree still has exactly one top", async () => {
    await post(`the board: $${ROOT_TICKER}`);
    const row = db.prepare("SELECT parent_symbol FROM tickers WHERE symbol = ?").get(ROOT_TICKER);
    expect(row).toEqual({ parent_symbol: null });
  });

  it("resolves to nothing while unclaimed — which is what falls through to the feed", async () => {
    // The pre-plural spelling is never claimed, so this is also the case that
    // keeps old `/$openbook` links landing on the feed rather than erroring.
    expect(await resolveTickers(["OPENBOOK"])).toEqual({});
  });

  it("puts a top-level claim under the root, named or not", async () => {
    await post("an ordinary idea, $Zulu");
    expect(await getTickerPath("ZULU")).toEqual([ROOT_TICKER, "ZULU"]);
  });
});
