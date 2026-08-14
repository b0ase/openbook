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
import {
  claimNym,
  createPost,
  getNym,
  getNyms,
  getPosts,
  getThread,
  getTickerPath,
  getTickerSupply,
  isReservedTicker,
  listTickers,
  releaseTickers,
  reserveTickers,
  resolveTickers,
  searchTickers,
} from "./actions";

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
  db.exec("DELETE FROM reserved_tickers");
  db.exec("DELETE FROM nyms");
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
  // Claiming the board's own name must stay an ordinary registration, because
  // the ROUTING no longer depends on whether it happens to be claimed: `/` is
  // the root's one address, and `/$openbooks` redirects there whether or not a
  // post ever named it (`tickerHref` / the catch-all's `redirectIfRoot`).
  //
  // What these pin is that the claim itself is still normal — same registry row,
  // same resolution, no parent. An earlier rule read the other way round and let
  // `handleOpenTicker` push `/$openbooks` for a claimed root, which is how the
  // address bar grew a path nobody typed.

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

describe("token supply is counted from mentions", () => {
  // The bug this pins: supply used to be "posts in the ticker's own thread", so
  // TWO posts naming $Branch both rendered (100%) — arithmetically impossible,
  // and 100% was shown on a post that holds none of it because it sits in a
  // different thread. Mentions are what the citation model counts.

  it("gives two mentions two units, not one each", async () => {
    await post("claiming $Branch");
    await post("citing $Branch back");
    expect(await getTickerSupply(["BRANCH"])).toEqual({ BRANCH: 2 });
  });

  it("counts a post once however many times it repeats the name", async () => {
    // Otherwise anyone can inflate a figure readers treat as significance just
    // by typing the same word twice.
    await post("$Branch $Branch $Branch all in one post");
    expect(await getTickerSupply(["BRANCH"])).toEqual({ BRANCH: 1 });
  });

  it("does not let $Branch absorb $Branches", async () => {
    // The SQL prefilter is `%$BRANCH%`, which matches both — every candidate is
    // re-checked against the real parse rule for exactly this reason.
    await post("about $Branches only");
    expect(await getTickerSupply(["BRANCH"])).toEqual({});
    expect(await getTickerSupply(["BRANCHES"])).toEqual({ BRANCHES: 1 });
  });

  it("ignores a $ that is not a ticker at all", async () => {
    await post("it cost $50 and US$20, and foo$Branch is not a mention");
    expect(await getTickerSupply(["BRANCH"])).toEqual({});
  });

  it("omits an unmentioned name rather than reporting zero", async () => {
    // The renderer draws no figure when a symbol is absent; a 0% would read as
    // "worthless" instead of "not a token yet".
    expect(await getTickerSupply(["NOBODYSAIDTHIS"])).toEqual({});
  });
});

describe("the index — searchTickers / listTickers", () => {
  // Until this existed a ticker could be claimed, priced and linked but never
  // FOUND. Ranking is by SUPPLY on purpose: that is attention somebody paid for,
  // not a signal inferred from something free to manufacture (DIRECTION.md).

  it("finds a ticker by a fragment of its name", async () => {
    await post("claiming $Forestfire");
    const hits = await searchTickers("orest");
    expect(hits.map((h) => h.symbol)).toContain("FORESTFIRE");
  });

  it("tolerates a leading $ and any casing, like a user would type", async () => {
    await post("claiming $Forestfire");
    for (const q of ["$forestfire", "FORESTFIRE", "$FoReSt"]) {
      expect((await searchTickers(q)).map((h) => h.symbol)).toContain("FORESTFIRE");
    }
  });

  it("ranks by supply, so the heavier name wins", async () => {
    await post("$Alpha starts");
    await post("$Beta starts");
    // Three posts name $Beta, one names $Alpha.
    await post("more about $Beta");
    await post("still more $Beta");

    // "a" is a PREFIX of $Alpha and only an interior match in $Beta, so this
    // also pins that weight outranks text shape — the earlier implementation
    // sorted prefix first and put the unknown name on top.
    const hits = await searchTickers("a");
    const alpha = hits.findIndex((h) => h.symbol === "ALPHA");
    const beta = hits.findIndex((h) => h.symbol === "BETA");
    expect(beta).toBeGreaterThanOrEqual(0);
    expect(beta).toBeLessThan(alpha);
  });

  it("puts a prefix match above an interior one AT EQUAL WEIGHT", async () => {
    // Both named once, so weight ties and the prefix decides: someone typing
    // "fore" wants $Forest before $Wildfore.
    await post("$Forest here");
    await post("$Wildfore here");
    const hits = await searchTickers("fore");
    expect(hits[0]?.symbol).toBe("FOREST");
  });

  it("carries the ancestry so a result links to the right path", async () => {
    await post("$Parent starts");
    const parentRoot = lastId();
    await post("$Child inside it", parentRoot);
    const child = (await searchTickers("child"))[0];
    expect(child?.path).toEqual([ROOT_TICKER, "PARENT", "CHILD"]);
  });

  it("returns nothing for an empty or junk query rather than everything", async () => {
    await post("$Something");
    expect(await searchTickers("")).toEqual([]);
    expect(await searchTickers("   ")).toEqual([]);
    expect(await searchTickers("$")).toEqual([]);
  });

  it("lists every claimed name heaviest first", async () => {
    await post("$Quiet once");
    await post("$Loud once");
    await post("$Loud twice");
    const all = await listTickers();
    expect(all[0]?.symbol).toBe("LOUD");
    expect(all.map((t) => t.symbol)).toContain("QUIET");
  });
});

describe("$Nym — a public name is an ordinary ticker claim", () => {
  // The design point these pin: a nym is NOT a privileged kind of name. It is
  // claimed by POSTING, obeys first-claim-wins through the same PRIMARY KEY as
  // every other symbol, and the `nyms` table only records which of an identity's
  // claims is the one it goes by.

  async function claim(symbol: string, name = "anon_nym1") {
    const key = PrivateKey.fromRandom();
    const content = `I'm $${symbol}`;
    const fd = new FormData();
    fd.set("symbol", symbol);
    fd.set("content", content);
    fd.set("author", name);
    fd.set("pubkey", key.toPublicKey().toString());
    fd.set(
      "signature",
      key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
    );
    return { res: await claimNym(fd), pubkey: key.toPublicKey().toString() };
  }

  it("claims the name and records it as the identity's nym", async () => {
    const { res, pubkey } = await claim("Harry");
    expect(res).toEqual({ ok: true, symbol: "HARRY" });
    expect(await getNym(pubkey)).toBe("HARRY");
    // ...and it is a real ticker, resolvable like any other.
    expect(await resolveTickers(["HARRY"])).toMatchObject({ HARRY: expect.anything() });
  });

  it("refuses a name somebody already holds", async () => {
    await claim("Harry");
    const second = await claim("Harry", "anon_nym2");
    expect(second.res).toEqual({ ok: false, reason: "taken" });
    expect(await getNym(second.pubkey)).toBeNull();
  });

  it("refuses names the ticker rule refuses, so there is one parse rule", async () => {
    for (const bad of ["", "  ", "1abc", "$", "waytoolongtobeanameatall"]) {
      const fd = new FormData();
      fd.set("symbol", bad);
      expect(await claimNym(fd)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("replaces the old name rather than accumulating", async () => {
    const key = PrivateKey.fromRandom();
    const pubkey = key.toPublicKey().toString();
    async function adopt(symbol: string) {
      const content = `I'm $${symbol}`;
      const fd = new FormData();
      fd.set("symbol", symbol);
      fd.set("content", content);
      fd.set("author", "anon_nym3");
      fd.set("pubkey", pubkey);
      fd.set(
        "signature",
        key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
      );
      return claimNym(fd);
    }
    expect(await adopt("First")).toEqual({ ok: true, symbol: "FIRST" });
    expect(await adopt("Second")).toEqual({ ok: true, symbol: "SECOND" });
    // One identity, one public name — and the first name is still THEIR ticker.
    expect(await getNym(pubkey)).toBe("SECOND");
    expect(db.prepare("SELECT COUNT(*) n FROM nyms WHERE pubkey = ?").get(pubkey)).toEqual({
      n: 1,
    });
    expect(await resolveTickers(["FIRST"])).toMatchObject({ FIRST: expect.anything() });
  });

  it("looks up many names at once for a feed", async () => {
    const a = await claim("Alpha", "anon_nyma");
    const b = await claim("Beta", "anon_nymb");
    const map = await getNyms([a.pubkey, b.pubkey, "02notanybody"]);
    expect(map[a.pubkey]).toBe("ALPHA");
    expect(map[b.pubkey]).toBe("BETA");
    expect(Object.keys(map)).toHaveLength(2);
  });
});

describe("reserved names — insurance, not censorship", () => {
  // Claiming the common vocabulary costs ~$2 once inscription exists, so the
  // namespace can be cornered by whoever scripts it first. Reserving holds names
  // open for nothing. The difference between this and a landgrab is the RELEASE
  // path, so that is tested as carefully as the reservation.

  it("stops a post from claiming a reserved name", async () => {
    await reserveTickers(["Water"]);
    expect((await post("thoughts on $Water")).ok).toBe(true);
    expect(await resolveTickers(["WATER"])).toEqual({});
  });

  it("still publishes the post — a reservation is not a word filter", async () => {
    await reserveTickers(["Water"]);
    const res = await post("thoughts on $Water");
    expect(res.ok).toBe(true);
    const row = db.prepare("SELECT content FROM posts WHERE id = ?").get(lastId()) as {
      content: string;
    };
    expect(row.content).toBe("thoughts on $Water");
  });

  it("claims the unreserved names in the same post", async () => {
    // A post naming one held name and one free one must still found the free one.
    await reserveTickers(["Water"]);
    expect((await post("$Water and $Fire together")).ok).toBe(true);
    expect(await resolveTickers(["WATER"])).toEqual({});
    expect(await resolveTickers(["FIRE"])).toMatchObject({ FIRE: expect.anything() });
  });

  it("refuses to reserve a name somebody already holds", async () => {
    await post("claiming $Mine first");
    const out = await reserveTickers(["Mine", "Unclaimed"]);
    expect(out.alreadyClaimed).toEqual(["MINE"]);
    expect(out.reserved).toEqual(["UNCLAIMED"]);
    // The existing claim is untouched — first-claim-wins cannot be revised later.
    expect(await resolveTickers(["MINE"])).toMatchObject({ MINE: expect.anything() });
  });

  it("releases a name back so it can be claimed again", async () => {
    await reserveTickers(["Water"]);
    await post("first go at $Water");
    expect(await resolveTickers(["WATER"])).toEqual({});

    expect(await releaseTickers(["Water"])).toBe(1);
    expect(await isReservedTicker("Water")).toBe(false);
    expect((await post("second go at $Water")).ok).toBe(true);
    expect(await resolveTickers(["WATER"])).toMatchObject({ WATER: expect.anything() });
  });

  it("ignores junk rather than reserving nonsense", async () => {
    const out = await reserveTickers(["", "  ", "1bad", "$"]);
    expect(out.reserved).toEqual([]);
    expect(await releaseTickers([])).toBe(0);
  });
});

/**
 * The mention edge — `(from_post, ticker, target)`.
 *
 * Supply is what ranks the public index, so these tests exist to prove the
 * COUNT is right at the edges where the old `LIKE '%$SYM%' LIMIT 500` content
 * scan was not, and to pin the target discriminator that tagging will use
 * before there is any tagging UI to exercise it.
 */
describe("ticker mentions — the (from_post, ticker, target) edge", () => {
  it("counts ONE unit per post, however many times a name is repeated in it", async () => {
    await post("$MEMEPLEX $MEMEPLEX $MEMEPLEX all at once");

    const supply = await getTickerSupply(["MEMEPLEX"]);
    // Counting repetition would let anyone inflate a figure readers treat as
    // significance just by typing the same word again.
    expect(supply.MEMEPLEX).toBe(1);
  });

  it("counts one unit per post that names it, across posts", async () => {
    await post("$MEMEPLEX");
    await post("$MEMEPLEX again");
    await post("$MEMEPLEX once more");

    expect((await getTickerSupply(["MEMEPLEX"])).MEMEPLEX).toBe(3);
  });

  it("counts a mention of a RESERVED name — it claimed nothing, but it was said", async () => {
    reserveTickers(["WATER"]);
    await post("a post about $WATER");

    // The claim is refused (that is the reservation), but the mention happened
    // and supply must reflect what people actually wrote.
    expect((await resolveTickers(["WATER"])).WATER).toBeUndefined();
    expect((await getTickerSupply(["WATER"])).WATER).toBe(1);
  });

  it("counts past 500 posts — the old content scan was silently capped there", async () => {
    const insert = db.prepare(
      "INSERT INTO posts (content, author_name, pubkey) VALUES (?, 'anon_bulk', 'pk_bulk')"
    );
    const mention = db.prepare(
      `INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, pubkey, target_type)
       VALUES ('BULK', ?, 'pk_bulk', 'none')`
    );
    db.transaction(() => {
      for (let i = 0; i < 620; i++) mention.run(insert.run(`$BULK ${i}`).lastInsertRowid as number);
    })();

    expect((await getTickerSupply(["BULK"])).BULK).toBe(620);
  });

  it("stores an untargeted mention for prose — the `none` case", async () => {
    await post("$SEO matters");
    const row = db.prepare("SELECT * FROM ticker_mentions WHERE symbol = 'SEO'").get() as {
      target_type: string;
      target_post_id: number | null;
      target_symbol: string | null;
    };
    expect(row.target_type).toBe("none");
    expect(row.target_post_id).toBeNull();
    expect(row.target_symbol).toBeNull();
  });

  it("accepts both target kinds — a tag on a post and a tag on a ticker", async () => {
    await post("$MEMEPLEX");
    const target = lastId();
    await post("tagging it");
    const from = lastId();

    // No writer for these yet (tagging is gated on paid posting); the schema
    // has to accept them so that gate opens onto a table that already fits.
    db.prepare(
      `INSERT INTO ticker_mentions (symbol, post_id, pubkey, target_type, target_post_id)
       VALUES ('PROFOUND', ?, 'pk_tagger', 'post', ?)`
    ).run(from, target);
    db.prepare(
      `INSERT INTO ticker_mentions (symbol, post_id, pubkey, target_type, target_symbol)
       VALUES ('PRETENTIOUS', ?, 'pk_tagger', 'ticker', 'MEMEPLEX')`
    ).run(from);

    expect(await getTickerSupply(["PROFOUND", "PRETENTIOUS"])).toEqual({
      PROFOUND: 1,
      PRETENTIOUS: 1,
    });
  });

  it("rejects a target that contradicts its own type", async () => {
    await post("$MEMEPLEX");
    const id = lastId();

    // 'none' carrying a target, and 'post' carrying none — both incoherent, and
    // the CHECK is what stops a half-written edge from ever landing.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ticker_mentions (symbol, post_id, target_type, target_post_id)
           VALUES ('X', ?, 'none', ?)`
        )
        .run(id, id)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO ticker_mentions (symbol, post_id, target_type) VALUES ('X', ?, 'post')"
        )
        .run(id)
    ).toThrow();
  });

  it("lets one post tag two different posts with the SAME name", async () => {
    await post("first");
    const a = lastId();
    await post("second");
    const b = lastId();
    await post("the tagger");
    const from = lastId();

    const tag = db.prepare(
      `INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, target_type, target_post_id)
       VALUES ('COOL', ?, 'post', ?)`
    );
    tag.run(from, a);
    tag.run(from, b);
    tag.run(from, a); // duplicate of the first — must not add a second unit

    // Two units: the same name pointed at two different posts is two separate
    // acts, while re-tagging the same post is one.
    expect((await getTickerSupply(["COOL"])).COOL).toBe(2);
  });
});

describe("the feed shows a claimed $Nym instead of anon_xxxx", () => {
  it("carries the author's nym on every post they have ever written", async () => {
    const key = PrivateKey.fromRandom();
    const pubkey = key.toPublicKey().toString();
    const sign = (c: string) =>
      key.sign(Array.from(new TextEncoder().encode(c))).toDER("hex") as string;

    async function write(content: string) {
      const fd = new FormData();
      fd.set("content", content);
      fd.set("author", "anon_before");
      fd.set("pubkey", pubkey);
      fd.set("signature", sign(content));
      return createPost(fd);
    }

    // Posted BEFORE the nym exists — the join is live, so claiming a name later
    // renames the back catalogue too. That is what the claim flow promises.
    await write("written while still anonymous");

    const nymFd = new FormData();
    const nymContent = "I'm $B0ase";
    nymFd.set("symbol", "B0ASE");
    nymFd.set("content", nymContent);
    nymFd.set("author", "anon_before");
    nymFd.set("pubkey", pubkey);
    nymFd.set("signature", sign(nymContent));
    expect((await claimNym(nymFd)).ok).toBe(true);

    const posts = await getPosts();
    const mine = posts.filter((p) => p.pubkey === pubkey);
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine) expect(p.author_nym).toBe("B0ASE");
  });

  it("leaves author_nym null for an identity that has not claimed one", async () => {
    await post("no name here");
    const posts = await getPosts();
    expect(posts[0].author_nym).toBeNull();
  });
});
