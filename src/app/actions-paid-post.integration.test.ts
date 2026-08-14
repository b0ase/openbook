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
import { MIN_ECONOMIC_OUTPUT_SATS } from "@/lib/post-economics";
import { buildInscriptionScript, INSCRIPTION_SATS } from "@/services/bsv/inscription";
import { logPostOnChain } from "@/services/bsv/onchain";
import { createPost } from "./actions";

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
    expect((await createPost(form(me, content, fundedTx(me, { content })))).ok).toBe(true);

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
