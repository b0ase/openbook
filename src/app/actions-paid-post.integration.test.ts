/**
 * Paid posting through the real `createPost` path.
 *
 * The flag defaults OFF, so every other integration test exercises the free
 * server-funded path and none of them would notice this branch breaking. These
 * turn it on.
 *
 * What matters here is that paying buys a post and NOTHING ELSE: the signature
 * check, the content screen and the rate limits all still run, and a post that
 * did not pay does not fall back to being free.
 */

import { P2PKH, PrivateKey, Transaction, Utils } from "@bsv/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // ⚠ Inlined, not a const: vi.mock factories are HOISTED above module-level
  // declarations, so referencing one here throws "cannot access before
  // initialization" at import time.
  getServerAddress: vi.fn().mockReturnValue("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"),
  getBalance: vi.fn().mockResolvedValue(500_000),
  buildAndBroadcast: vi.fn(),
  SERVER_FEE_BUFFER_SATS: 300,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(
    new Map([
      ["x-forwarded-for", "10.0.0.44"],
      ["x-real-ip", "10.0.0.44"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { MINT_SLACK_UNITS } from "@/lib/mint-charge";
import { MINT_BASE_SATS } from "@/lib/mint-price";
import { MIN_ECONOMIC_OUTPUT_SATS, postPrice } from "@/lib/post-economics";

/** Shorthand — the markup floor rides alongside every mint charge below. */
const MIN_ECONOMIC = MIN_ECONOMIC_OUTPUT_SATS;

import { buildInscriptionScript, INSCRIPTION_SATS } from "@/services/bsv/inscription";
import { logPostOnChain } from "@/services/bsv/onchain";
import { createPost, getPostingMode } from "./actions";

// ⚠ A REAL base58 address, unlike the "1PlatformAddressForTests" placeholder
// the other suites use. Those only ever hand it back from a mock; this suite
// LOCKS an output to it, and P2PKH.lock rejects invalid base58.
const PLATFORM = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

/**
 * A FRESH identity per test.
 *
 * `createPost` rate-limits 10/min per pubkey, so a shared key would make this
 * suite fail once it grew past ten posts — a flake that looks like a paid-post
 * bug and is not one.
 */
function identity() {
  const key = PrivateKey.fromRandom();
  return {
    key,
    pubkey: key.toPublicKey().toString(),
    address: key.toPublicKey().toAddress().toString(),
  };
}

type Identity = ReturnType<typeof identity>;

/** A transaction shaped the way `clientSidePost` builds one. */
function fundedTx(
  who: Identity,
  opts: { content: string; owner?: string; platformSats?: number }
): string {
  const tx = new Transaction();
  tx.addOutput({
    lockingScript: buildInscriptionScript({
      address: opts.owner ?? who.address,
      contentType: "application/json",
      data: Utils.toArray(
        JSON.stringify({ v: 1, app: "openbooks", type: "post", content: opts.content }),
        "utf8"
      ),
    }),
    satoshis: INSCRIPTION_SATS,
  });
  tx.addOutput({
    lockingScript: new P2PKH().lock(PLATFORM),
    satoshis: opts.platformSats ?? MIN_ECONOMIC_OUTPUT_SATS,
  });
  return tx.toHex();
}

function form(who: Identity, content: string, rawTx?: string): FormData {
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_paid");
  fd.set("pubkey", who.pubkey);
  fd.set(
    "signature",
    who.key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
  );
  if (rawTx !== undefined) fd.set("raw_tx", rawTx);
  return fd;
}

beforeEach(() => {
  process.env.PAID_POSTING = "true";
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM ticker_holdings");
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.PAID_POSTING = undefined;
});

describe("paid posting", () => {
  it("accepts a funded post and stores its OUTPOINT", async () => {
    const me = identity();
    const content = "a post I paid for";
    const rawTx = fundedTx(me, { content });

    expect((await createPost(form(me, content, rawTx))).ok).toBe(true);

    const row = db.prepare("SELECT tx_id, vout FROM posts WHERE content = ?").get(content) as {
      tx_id: string;
      vout: number;
    };
    // txid + vout is the token's identity — derived from the bytes, not accepted.
    expect(row.tx_id).toBe(Transaction.fromHex(rawTx).id("hex"));
    expect(row.vout).toBe(0);
  });

  it("does NOT spend server funds anchoring a post the author already paid for", async () => {
    // Double-anchoring would cost the operator money to duplicate a record the
    // author bought, and leave the sweep retrying a post that already has a txid.
    const me = identity();
    await createPost(form(me, "already mine", fundedTx(me, { content: "already mine" })));
    expect(logPostOnChain).not.toHaveBeenCalled();
  });

  it("REFUSES a post with no transaction rather than falling back to free", async () => {
    // A fallback would make the gate meaningless — omit a field, post for free.
    const res = await createPost(form(identity(), "freeloader"));
    expect(res).toEqual({ ok: false, reason: "payment_required" });
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 0 });
  });

  it("REFUSES when the inscription says something other than the post", async () => {
    const me = identity();
    const res = await createPost(
      form(me, "what I store", fundedTx(me, { content: "what I inscribed" }))
    );
    expect(res).toEqual({ ok: false, reason: "invalid_payment" });
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 0 });
  });

  it("REFUSES when the platform was paid nothing", async () => {
    const me = identity();
    const content = "no fee";
    const res = await createPost(form(me, content, fundedTx(me, { content, platformSats: 1 })));
    expect(res).toEqual({ ok: false, reason: "invalid_payment" });
  });

  it("REFUSES an inscription owned by somebody else", async () => {
    const me = identity();
    const content = "not mine";
    const res = await createPost(
      form(me, content, fundedTx(me, { content, owner: identity().address }))
    );
    expect(res).toEqual({ ok: false, reason: "invalid_payment" });
  });

  it("REFUSES to mint two posts from one broadcast", async () => {
    // Replay: the same paid transaction must buy exactly one post.
    const me = identity();
    const content = "pay once";
    const rawTx = fundedTx(me, { content });
    expect((await createPost(form(me, content, rawTx))).ok).toBe(true);

    const again = await createPost(form(me, content, rawTx));
    expect(again).toEqual({ ok: false, reason: "invalid_payment" });
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 1 });
  });

  /**
   * The mint curve, charged.
   *
   * A post naming a `$Ticker` mints a unit of it, and the price of that unit
   * rises with the word's supply. These are the two ways that can go wrong with
   * somebody's money: accepting a post that minted a word it did not pay for,
   * and refusing one whose author paid the price they were quoted a moment
   * before somebody else pushed it up.
   */
  describe("the mint charge", () => {
    it("REFUSES a post that names a ticker but paid only the markup", async () => {
      const me = identity();
      const content = "starting $Mintfloor right here";
      const res = await createPost(
        form(me, content, fundedTx(me, { content, platformSats: MIN_ECONOMIC_OUTPUT_SATS }))
      );
      expect(res).toEqual({ ok: false, reason: "invalid_payment" });
      // Refused BEFORE the insert — so nothing was stored and nothing was minted.
      expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM ticker_mentions").get()).toEqual({ n: 0 });
    });

    it("accepts a post that paid the markup PLUS the mint price", async () => {
      const me = identity();
      const content = "starting $Mintok right here";
      const paid = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
      expect(
        (await createPost(form(me, content, fundedTx(me, { content, platformSats: paid })))).ok
      ).toBe(true);
      // The unit it paid for exists.
      const row = db
        .prepare("SELECT COUNT(*) n FROM ticker_mentions WHERE symbol = 'MINTOK'")
        .get();
      expect(row).toEqual({ n: 1 });
    });

    it("charges nothing extra for a post that names no ticker", async () => {
      // The overwhelming majority of posts. The curve must not creep into them.
      const me = identity();
      const content = "no tickers in this one at all";
      expect((await createPost(form(me, content, fundedTx(me, { content })))).ok).toBe(true);
    });

    it("SUMS the words, so an expensive name cannot ride along on a cheap post", async () => {
      // Two distinct words mint two units, so one unit's price is not enough.
      const me = identity();
      const content = "$Alpha meets $Beta";
      const oneUnit = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
      expect(
        await createPost(form(me, content, fundedTx(me, { content, platformSats: oneUnit })))
      ).toEqual({ ok: false, reason: "invalid_payment" });

      const both = MIN_ECONOMIC_OUTPUT_SATS + 2 * MINT_BASE_SATS;
      expect(
        (await createPost(form(me, content, fundedTx(me, { content, platformSats: both })))).ok
      ).toBe(true);
    });

    it("does NOT count the post's own mention — the author is quoted the price they pay", async () => {
      // The mention is recorded AFTER verification. If it were counted first,
      // every author would be billed one unit more than they were quoted.
      const me = identity();
      const content = "$Selfcount";
      const exact = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
      expect(
        (await createPost(form(me, content, fundedTx(me, { content, platformSats: exact })))).ok
      ).toBe(true);
    });

    it("accepts a quote that went stale while other people minted the same word", async () => {
      // The race: supply rises between the quote and the broadcast, through no
      // fault of the author. Rejecting here would take their money and store
      // nothing, so the floor forgives MINT_SLACK_UNITS of drift.
      const first = identity();
      const stale = "$Drifting";
      // Somebody else mints the word several times over.
      for (let i = 0; i < MINT_SLACK_UNITS; i++) {
        const who = identity();
        const text = `${stale} again ${i}`;
        const cost = MIN_ECONOMIC_OUTPUT_SATS + (i + 1) * MINT_BASE_SATS;
        expect(
          (await createPost(form(who, text, fundedTx(who, { content: text, platformSats: cost }))))
            .ok
        ).toBe(true);
      }
      // Our author quoted at the ORIGINAL supply and pays that older price.
      const content = `${stale} at yesterday's price`;
      const quotedThen = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
      expect(
        (
          await createPost(
            form(first, content, fundedTx(first, { content, platformSats: quotedThen }))
          )
        ).ok
      ).toBe(true);
    });

    it("does NOT forgive drift beyond the slack", async () => {
      // The band is a tolerance, not an exemption — otherwise the price never
      // actually rises for anyone patient enough to hold a stale quote.
      const stale = "$Waybehind";
      for (let i = 0; i < MINT_SLACK_UNITS + 3; i++) {
        const who = identity();
        const text = `${stale} again ${i}`;
        const cost = MIN_ECONOMIC_OUTPUT_SATS + (i + 1) * MINT_BASE_SATS;
        expect(
          (await createPost(form(who, text, fundedTx(who, { content: text, platformSats: cost }))))
            .ok
        ).toBe(true);
      }
      const me = identity();
      const content = `${stale} much later`;
      const longStale = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
      expect(
        await createPost(form(me, content, fundedTx(me, { content, platformSats: longStale })))
      ).toEqual({ ok: false, reason: "invalid_payment" });
    });
  });

  /**
   * `/buy N $Ticker` — units without a post about the word.
   *
   * It goes through `createPost` like everything else that reaches the chain,
   * so what is tested here is the part that is NOT like everything else: the
   * price is quadratic, one row carries many units, and a buy must never be
   * billed as an ordinary one-unit mention.
   */
  describe("bulk buy", () => {
    it("mints the units it paid for, in ONE row", async () => {
      const me = identity();
      const content = "/buy 10 $Bulk";
      // 10 units from an empty supply: 113 × (1+2+…+10).
      const mint = MINT_BASE_SATS * ((10 * 11) / 2);
      expect(
        (
          await createPost(
            form(me, content, fundedTx(me, { content, platformSats: MIN_ECONOMIC + mint }))
          )
        ).ok
      ).toBe(true);

      const rows = db
        .prepare("SELECT COUNT(*) AS rows, SUM(units) AS units FROM ticker_mentions WHERE symbol=?")
        .get("BULK") as { rows: number; units: number };
      // ⚠ ONE ROW. The unique index on (post_id, symbol) is why units is a
      // column rather than ten rows — see the note in db.ts.
      expect(rows).toEqual({ rows: 1, units: 10 });
    });

    it("REFUSES a bulk buy paid for as a single mention", async () => {
      // The failure this exists to catch: `/buy 1000 $X` names a ticker, so a
      // charge that fell through to the ordinary path would bill for one unit
      // and mint a thousand.
      const me = identity();
      const content = "/buy 1000 $Cheapskate";
      const oneUnit = MIN_ECONOMIC + MINT_BASE_SATS;
      expect(
        await createPost(form(me, content, fundedTx(me, { content, platformSats: oneUnit })))
      ).toEqual({ ok: false, reason: "invalid_payment" });
      expect(db.prepare("SELECT COUNT(*) n FROM ticker_mentions").get()).toEqual({ n: 0 });
    });

    it("prices the SECOND buy higher — the curve is the mechanism", async () => {
      const first = identity();
      // ⚠ 20 UNITS, COMFORTABLY PAST `MINT_SLACK_UNITS`. At a smaller supply the
      // tolerance band legitimately swallows the whole rise, and the test would
      // be asserting the band rather than the curve.
      const a = "/buy 20 $Rising";
      const costA = MINT_BASE_SATS * ((20 * 21) / 2);
      expect(
        (
          await createPost(
            form(first, a, fundedTx(first, { content: a, platformSats: MIN_ECONOMIC + costA }))
          )
        ).ok
      ).toBe(true);

      // Supply is 20, so the next five units are the 21st through 25th — and the
      // price of the FIRST five is no longer enough to buy them.
      const second = identity();
      const b = "/buy 5 $Rising";
      const firstFive = MIN_ECONOMIC + MINT_BASE_SATS * (1 + 2 + 3 + 4 + 5);
      expect(
        await createPost(form(second, b, fundedTx(second, { content: b, platformSats: firstFive })))
      ).toEqual({ ok: false, reason: "invalid_payment" });

      const costB = MINT_BASE_SATS * (21 + 22 + 23 + 24 + 25);
      expect(
        (
          await createPost(
            form(second, b, fundedTx(second, { content: b, platformSats: MIN_ECONOMIC + costB }))
          )
        ).ok
      ).toBe(true);
      expect(
        db.prepare("SELECT SUM(units) AS n FROM ticker_mentions WHERE symbol='RISING'").get()
      ).toEqual({ n: 25 });
    });

    it("claims an unclaimed word — buying it IS a founding act", async () => {
      const me = identity();
      const content = "/buy 3 $Founded";
      const mint = MINT_BASE_SATS * (1 + 2 + 3);
      expect(
        (
          await createPost(
            form(me, content, fundedTx(me, { content, platformSats: MIN_ECONOMIC + mint }))
          )
        ).ok
      ).toBe(true);
      expect(db.prepare("SELECT symbol FROM tickers WHERE symbol='FOUNDED'").get()).toBeDefined();
    });

    it("treats a near-miss as an ordinary post, not a purchase", async () => {
      // `/buy 10 $A for the room` is prose. It must mint ONE unit like any other
      // post that names a word — never ten, and never be refused as underpaid.
      const me = identity();
      const content = "/buy 10 $Nearmiss for the room";
      expect(
        (
          await createPost(
            form(
              me,
              content,
              fundedTx(me, { content, platformSats: MIN_ECONOMIC + MINT_BASE_SATS })
            )
          )
        ).ok
      ).toBe(true);
      expect(
        db.prepare("SELECT SUM(units) AS n FROM ticker_mentions WHERE symbol='NEARMISS'").get()
      ).toEqual({ n: 1 });
    });
  });

  it("still rejects a bad signature — paying buys a post, not an exemption", async () => {
    const me = identity();
    const content = "forged";
    const fd = form(me, content, fundedTx(me, { content }));
    fd.set("signature", "not-a-signature");
    expect(await createPost(fd)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("still claims tickers and records mentions on a paid post", async () => {
    const me = identity();
    const content = "naming $Paid here";
    // ⚠ Funds the MINT as well as the markup. Naming a word mints a unit of it
    // and the unit has a price — this test paid only the markup until the curve
    // was charged, and would now be refused for underpayment.
    const platformSats = MIN_ECONOMIC_OUTPUT_SATS + MINT_BASE_SATS;
    expect((await createPost(form(me, content, fundedTx(me, { content, platformSats })))).ok).toBe(
      true
    );

    expect(db.prepare("SELECT symbol FROM tickers WHERE symbol = 'PAID'").get()).toBeDefined();
    expect(
      db.prepare("SELECT COUNT(*) n FROM ticker_mentions WHERE symbol = 'PAID'").get()
    ).toEqual({ n: 1 });
  });

  it("leaves the free path untouched when the flag is off", async () => {
    process.env.PAID_POSTING = "false";
    const res = await createPost(form(identity(), "free as before"));
    expect(res.ok).toBe(true);
    expect(logPostOnChain).toHaveBeenCalled();

    const row = db.prepare("SELECT vout FROM posts WHERE content = 'free as before'").get() as {
      vout: number | null;
    };
    // No outpoint: an OP_RETURN record has no ownable output to point at.
    expect(row.vout).toBeNull();
  });
});

/**
 * ⚠ THE REGRESSION THIS SUITE EXISTED WITHOUT.
 *
 * Every test above builds its transaction from a hand-written fixture, so all of
 * them passed while the CLIENT was being quoted a different price from the one
 * the SERVER demanded. The first real paid post was rejected as underpaid —
 * after the author had broadcast and paid — because `getPostingMode` read a
 * blank `POST_MARKUP_PERCENT` as 0% (`Number("") === 0`) and built no platform
 * output.
 *
 * So these assert the contract that actually matters: WHATEVER getPostingMode
 * TELLS THE CLIENT, createPost MUST ACCEPT.
 */
describe("the quote the client is given is one the server accepts", () => {
  for (const [label, envValue] of [
    ["unset", undefined],
    ["blank", ""],
    ["explicit zero (at-cost)", "0"],
    ["ten percent", "10"],
  ] as [string, string | undefined][]) {
    it(`agrees when POST_MARKUP_PERCENT is ${label}`, async () => {
      process.env.POST_MARKUP_PERCENT = envValue;

      const mode = await getPostingMode();
      expect(mode.paid).toBe(true);

      // Price it exactly as the compose box does.
      const price = postPrice(800, { markupPercent: mode.markupPercent });

      const me = identity();
      const content = `quote agreement: ${label}`;
      const tx = new Transaction();
      tx.addOutput({
        lockingScript: buildInscriptionScript({
          address: me.address,
          contentType: "application/json",
          data: Utils.toArray(
            JSON.stringify({ v: 1, app: "openbooks", type: "post", content }),
            "utf8"
          ),
        }),
        satoshis: INSCRIPTION_SATS,
      });
      // The client only adds a platform output when the quote says to.
      if (price.platformFeeSats > 0 && mode.platformAddress) {
        tx.addOutput({
          lockingScript: new P2PKH().lock(mode.platformAddress),
          satoshis: price.platformFeeSats,
        });
      }

      const res = await createPost(form(me, content, tx.toHex()));
      expect(res).toEqual({ ok: true });
    });
  }
});
