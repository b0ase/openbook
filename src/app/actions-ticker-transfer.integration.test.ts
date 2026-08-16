/**
 * Handing a `$Ticker` to somebody else, through the real `createPost` path.
 *
 * This exists because a ticker is founded by whoever MENTIONS it first — so a
 * name can end up on the wrong key by accident, and with `symbol` as a PRIMARY
 * KEY there is no second instance and no way back without transfer.
 *
 * The security of the whole thing rests on one check: `createPost` verifies the
 * signature over the post CONTENT and knows nothing about the `symbol` and
 * `to_pubkey` form fields, which are unsigned. So the content must be checked to
 * BE the announcement. The "refuses a validly signed post with swapped fields"
 * test below is the one that matters.
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
      ["x-forwarded-for", "10.0.0.77"],
      ["x-real-ip", "10.0.0.77"],
    ])
  ),
}));

import { db } from "@/lib/db";
import { tickerTransferAnnouncement } from "@/lib/ticker-transfer";
import { claimNym, createPost, getNym, transferTicker } from "./actions";

// ⚠ FRESH KEYS PER TEST. createPost rate-limits per pubkey and the limiter is
// in-memory, so it survives the table truncation in beforeEach — reusing one key
// across the file throttles the later tests and they fail as "post_failed" for a
// reason that has nothing to do with transfers.
let alice: PrivateKey;
let bob: PrivateKey;
let alicePub: string;
let bobPub: string;

function sign(key: PrivateKey, content: string): string {
  return key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string;
}

/** A plain post by `key` — this is also how a ticker gets founded. */
async function post(key: PrivateKey, content: string) {
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_test");
  fd.set("pubkey", key.toPublicKey().toString());
  fd.set("signature", sign(key, content));
  return createPost(fd);
}

/** A transfer submitted exactly as the UI would submit it. */
async function transfer(from: PrivateKey, symbol: string, toPubkey: string) {
  const content = tickerTransferAnnouncement(symbol, toPubkey);
  const fd = new FormData();
  fd.set("symbol", symbol);
  fd.set("to_pubkey", toPubkey);
  fd.set("content", content);
  fd.set("author", "anon_test");
  fd.set("pubkey", from.toPublicKey().toString());
  fd.set("signature", sign(from, content));
  return transferTicker(fd);
}

const ownerOf = (symbol: string) =>
  (
    db.prepare("SELECT pubkey FROM tickers WHERE symbol = ?").get(symbol) as
      | { pubkey: string | null }
      | undefined
  )?.pubkey ?? null;

beforeEach(() => {
  alice = PrivateKey.fromRandom();
  bob = PrivateKey.fromRandom();
  alicePub = alice.toPublicKey().toString();
  bobPub = bob.toPublicKey().toString();
  db.exec("DELETE FROM nyms");
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("transferTicker", () => {
  it("moves a name founded by merely mentioning it", async () => {
    // Exactly how $CHESTERTON ended up on the wrong key in production.
    await post(alice, "$Occam and $Chesterton are opposing agents");
    expect(ownerOf("CHESTERTON")).toBe(alicePub);

    expect(await transfer(alice, "CHESTERTON", bobPub)).toEqual({
      ok: true,
      symbol: "CHESTERTON",
    });
    expect(ownerOf("CHESTERTON")).toBe(bobPub);
  });

  it("lets the recipient then claim it as their nym, which they could not before", async () => {
    await post(alice, "founding $Handover");
    // Before the transfer Bob cannot have it.
    const fdBefore = new FormData();
    const before = "I'm $Handover";
    fdBefore.set("symbol", "HANDOVER");
    fdBefore.set("content", before);
    fdBefore.set("author", "anon_bob");
    fdBefore.set("pubkey", bobPub);
    fdBefore.set("signature", sign(bob, before));
    expect(await claimNym(fdBefore)).toEqual({ ok: false, reason: "taken" });

    await transfer(alice, "HANDOVER", bobPub);

    const fdAfter = new FormData();
    fdAfter.set("symbol", "HANDOVER");
    fdAfter.set("content", before);
    fdAfter.set("author", "anon_bob");
    fdAfter.set("pubkey", bobPub);
    fdAfter.set("signature", sign(bob, before));
    expect(await claimNym(fdAfter)).toEqual({ ok: true, symbol: "HANDOVER" });
    expect(await getNym(bobPub)).toBe("HANDOVER");
  });

  // ── The check the whole thing rests on ──────────────────────────────────
  it("refuses a validly signed post whose form fields were swapped", async () => {
    await post(alice, "founding $Valuable and $Decoy");
    // Alice legitimately signs a transfer of $DECOY to Bob. An attacker (or a
    // buggy client) replays that signature with symbol swapped to $VALUABLE.
    const honest = tickerTransferAnnouncement("DECOY", bobPub);
    const fd = new FormData();
    fd.set("symbol", "VALUABLE"); // ← not what was signed
    fd.set("to_pubkey", bobPub);
    fd.set("content", honest);
    fd.set("author", "anon_test");
    fd.set("pubkey", alicePub);
    fd.set("signature", sign(alice, honest));

    expect(await transferTicker(fd)).toEqual({ ok: false, reason: "invalid" });
    expect(ownerOf("VALUABLE")).toBe(alicePub);
  });

  it("refuses when the recipient field does not match the signed content", async () => {
    await post(alice, "founding $Redirect");
    const honest = tickerTransferAnnouncement("REDIRECT", bobPub);
    const attacker = PrivateKey.fromRandom().toPublicKey().toString();
    const fd = new FormData();
    fd.set("symbol", "REDIRECT");
    fd.set("to_pubkey", attacker); // ← redirected
    fd.set("content", honest);
    fd.set("author", "anon_test");
    fd.set("pubkey", alicePub);
    fd.set("signature", sign(alice, honest));

    expect(await transferTicker(fd)).toEqual({ ok: false, reason: "invalid" });
    expect(ownerOf("REDIRECT")).toBe(alicePub);
  });

  it("refuses to give away a name the sender does not hold", async () => {
    await post(alice, "founding $NotYours");
    // Bob does not hold it; sending to a third party so this is not caught
    // earlier as a same-owner no-op.
    expect(await transfer(bob, "NOTYOURS", alicePub)).toEqual({ ok: false, reason: "not_owner" });
    expect(ownerOf("NOTYOURS")).toBe(alicePub);
  });

  it("refuses an unknown symbol rather than inventing ownership", async () => {
    expect(await transfer(alice, "NEVERFOUNDED", bobPub)).toEqual({
      ok: false,
      reason: "not_owner",
    });
  });

  it("refuses a transfer to the current holder, which would charge for nothing", async () => {
    await post(alice, "founding $Selfsend");
    expect(await transfer(alice, "SELFSEND", alicePub)).toEqual({
      ok: false,
      reason: "same_owner",
    });
  });

  it("refuses an address where a public key is required", async () => {
    await post(alice, "founding $Wrongform");
    const res = await transfer(alice, "WRONGFORM", "19j9p7Y8kmvmdAvkNfbLaygKAu3igr2mCH");
    expect(res).toEqual({ ok: false, reason: "invalid_recipient" });
    expect(ownerOf("WRONGFORM")).toBe(alicePub);
  });

  it("strips the old holder's display name when the name moves", async () => {
    await post(alice, "founding $Displayed");
    const content = "I'm $Displayed";
    const fd = new FormData();
    fd.set("symbol", "DISPLAYED");
    fd.set("content", content);
    fd.set("author", "anon_alice");
    fd.set("pubkey", alicePub);
    fd.set("signature", sign(alice, content));
    expect(await claimNym(fd)).toEqual({ ok: true, symbol: "DISPLAYED" });
    expect(await getNym(alicePub)).toBe("DISPLAYED");

    await transfer(alice, "DISPLAYED", bobPub);
    // Alice cannot keep going by a name she no longer owns.
    expect(await getNym(alicePub)).toBeNull();
    // And Bob is NOT given it automatically — owning and going by are separate acts.
    expect(await getNym(bobPub)).toBeNull();
  });

  it("cannot be replayed once the name has moved", async () => {
    await post(alice, "founding $Once");
    expect((await transfer(alice, "ONCE", bobPub)).ok).toBe(true);
    // Same signed announcement, submitted again — ownership is the nonce.
    expect(await transfer(alice, "ONCE", bobPub)).toEqual({ ok: false, reason: "not_owner" });
    expect(ownerOf("ONCE")).toBe(bobPub);
  });

  it("records the transfer as a real post, so the change of hands is public", async () => {
    await post(alice, "founding $Recorded");
    await transfer(alice, "RECORDED", bobPub);
    const row = db.prepare("SELECT content FROM posts ORDER BY id DESC LIMIT 1").get() as {
      content: string;
    };
    expect(row.content).toBe(tickerTransferAnnouncement("RECORDED", bobPub));
  });
});
