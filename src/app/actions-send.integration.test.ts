/**
 * `/send` through the real `createPost`.
 *
 * ⚠ WHAT THIS IS GUARDING. A send moves property with nothing coming back, and it
 * cannot be undone. The failures that matter are not "it didn't work" — they are
 * the ones where it works and does the wrong thing: minting a unit the sender was
 * not charged for, founding a token by trying to give it away, or reporting success
 * on a transfer that moved nothing.
 */

import { PrivateKey } from "@bsv/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/bsv/onchain", () => ({
  logPostOnChain: vi.fn().mockResolvedValue("mocktxid_post"),
  logRoomEntryOnChain: vi.fn().mockResolvedValue("mocktxid_entry"),
}));
vi.mock("@/services/bsv/anchor-sweep", () => ({
  sweepOrphans: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/link-unfurl", () => ({
  unfurl: vi.fn().mockResolvedValue({ ok: false, url: "", reason: "fetch_failed" }),
}));
// ⚠ Without this every post returns `paused`: the integration setup sets
// BSV_WALLET_SPEND_DISABLED so no test can ever spend real money, and the kill
// switch refuses posting outright.
vi.mock("@/services/bsv/wallet", () => ({
  isServerSpendDisabled: vi.fn().mockReturnValue(false),
  getServerAddress: vi.fn().mockReturnValue("1PlatformAddressForTests"),
  getBalance: vi.fn().mockResolvedValue(500_000),
  buildAndBroadcast: vi.fn(),
  SERVER_FEE_BUFFER_SATS: 300,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Map([["x-forwarded-for", "10.0.0.88"]])),
}));

import { db } from "@/lib/db";
import { mintedUnits, totalUnits, unitsHeld } from "@/lib/holdings";
import { mintChargeSats, mintFloorSats } from "@/lib/mint-charge";
import { createPost } from "./actions";

const ADDR = "14fRfJ8YCPQUcEtxhdJqchPXeca6NjEQpK";

function who() {
  const key = PrivateKey.fromRandom();
  return { key, pubkey: key.toPublicKey().toString() };
}
type Who = ReturnType<typeof who>;

async function post(me: Who, content: string) {
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_send");
  fd.set("pubkey", me.pubkey);
  fd.set(
    "signature",
    me.key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
  );
  return createPost(fd);
}

beforeEach(() => {
  db.exec("DELETE FROM room_entries");
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM ticker_holdings");
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM nyms");
  db.exec("DELETE FROM identity_addresses");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("a send moves units and mints nothing", () => {
  it("hands the units over", async () => {
    const alice = who();
    const bob = who();
    db.prepare("INSERT INTO nyms (pubkey, symbol) VALUES (?, 'BOB')").run(bob.pubkey);

    await post(alice, "/buy 5 $Occam");
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(5);

    const res = await post(alice, "/send 2 $Occam @Bob");
    expect(res).toEqual({ ok: true, send: { ok: true, units: 2, symbol: "OCCAM" } });
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(3);
    expect(unitsHeld("OCCAM", bob.pubkey)).toBe(2);
  });

  it("does NOT mint a fresh unit for the ticker it names", async () => {
    // ⚠ The bug this exists to catch. `/send 1 $Occam @Bob` names a ticker, so the
    // ordinary mention path would mint the SENDER a new unit — on top of the one
    // they are giving away, and having been charged nothing for it. Supply must be
    // invariant under a send.
    const alice = who();
    const bob = who();
    db.prepare("INSERT INTO nyms (pubkey, symbol) VALUES (?, 'BOB')").run(bob.pubkey);

    await post(alice, "/buy 3 $Occam");
    const mintedBefore = mintedUnits("OCCAM");
    const totalBefore = totalUnits("OCCAM");

    await post(alice, "/send 1 $Occam @Bob");

    expect(mintedUnits("OCCAM")).toBe(mintedBefore);
    expect(totalUnits("OCCAM")).toBe(totalBefore);
  });

  it("costs nothing to mint, so a paid post cannot be rejected for underpaying one", () => {
    // Both sides of the payment check must agree that a send owes zero. A floor
    // above zero would reject every send AFTER broadcast — taking the author's
    // network fee for a post that is then refused.
    expect(mintChargeSats("/send 1 $Occam @Bob")).toBe(0);
    expect(mintFloorSats("/send 1 $Occam @Bob")).toBe(0);
    expect(mintChargeSats(`/send 9 $Occam ${ADDR}`)).toBe(0);
  });

  it("does NOT found the token it tries to give away", async () => {
    // ⚠ Claiming is a side effect of NAMING, so without an exception here
    // `/send 1 $Nobody @Bob` would quietly found `$Nobody` — registering a name to
    // somebody who was trying to give it away and never had it.
    const alice = who();
    const bob = who();
    db.prepare("INSERT INTO nyms (pubkey, symbol) VALUES (?, 'BOB')").run(bob.pubkey);

    const res = await post(alice, "/send 1 $Nobody @Bob");
    expect(res.send).toEqual({ ok: false, reason: "insufficient_units" });
    expect(db.prepare("SELECT COUNT(*) n FROM tickers WHERE symbol = 'NOBODY'").get()).toEqual({
      n: 0,
    });
    expect(mintedUnits("NOBODY")).toBe(0);
  });
});

describe("a send that cannot happen moves nothing", () => {
  it("REFUSES an unknown recipient rather than burning the units", async () => {
    const alice = who();
    await post(alice, "/buy 2 $Occam");

    const res = await post(alice, "/send 1 $Occam @Ghost");
    expect(res.send).toEqual({ ok: false, reason: "unknown_recipient" });
    // ⚠ The sender still has everything. A send to nobody must not be a burn.
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(2);
    expect(totalUnits("OCCAM")).toBe(2);
  });

  it("REFUSES to overdraw", async () => {
    const alice = who();
    const bob = who();
    db.prepare("INSERT INTO nyms (pubkey, symbol) VALUES (?, 'BOB')").run(bob.pubkey);
    await post(alice, "/buy 2 $Occam");

    const res = await post(alice, "/send 5 $Occam @Bob");
    expect(res.send).toEqual({ ok: false, reason: "insufficient_units" });
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(2);
    expect(unitsHeld("OCCAM", bob.pubkey)).toBe(0);
  });

  it("REFUSES a send to yourself", async () => {
    // Not a no-op: it would debit and credit the same row for a net zero, succeed,
    // and leave a permanent public record of a transfer that did not happen.
    const alice = who();
    db.prepare("INSERT INTO nyms (pubkey, symbol) VALUES (?, 'ALICE')").run(alice.pubkey);
    await post(alice, "/buy 2 $Occam");

    const res = await post(alice, "/send 1 $Occam @Alice");
    expect(res.send).toEqual({ ok: false, reason: "self" });
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(2);
  });

  it("still PUBLISHES the post when the transfer fails", async () => {
    // The transfer runs after the post is stored and cannot un-store it. The
    // composer has to be able to say "that did not go through" about a message the
    // author can already see.
    const alice = who();
    await post(alice, "/buy 1 $Occam");
    const before = (db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n;

    const res = await post(alice, "/send 1 $Occam @Ghost");
    expect(res.ok).toBe(true);
    expect(res.send?.ok).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n).toBe(before + 1);
  });
});

describe("addressing a recipient who has no nym", () => {
  it("resolves a plain ADDRESS through identity_addresses", async () => {
    // ⚠ Most users are anon_XXXX and have never claimed a nym. A send that only
    // accepted nyms would be unusable for almost everybody.
    const alice = who();
    const bob = who();
    db.prepare("INSERT INTO identity_addresses (address, pubkey) VALUES (?, ?)").run(
      ADDR,
      bob.pubkey
    );

    await post(alice, "/buy 2 $Occam");
    const res = await post(alice, `/send 1 $Occam ${ADDR}`);

    expect(res.send).toEqual({ ok: true, units: 1, symbol: "OCCAM" });
    expect(unitsHeld("OCCAM", bob.pubkey)).toBe(1);
  });

  it("refuses an address nobody on this board has used", async () => {
    const alice = who();
    await post(alice, "/buy 1 $Occam");
    const res = await post(alice, `/send 1 $Occam ${ADDR}`);
    expect(res.send).toEqual({ ok: false, reason: "unknown_recipient" });
    expect(unitsHeld("OCCAM", alice.pubkey)).toBe(1);
  });
});
