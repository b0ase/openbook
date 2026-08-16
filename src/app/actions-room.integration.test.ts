/**
 * The room gate through the real `createPost`.
 *
 * ⚠ THIS IS THE HALF OF THE GATE THAT IS ENFORCED, and the only one worth
 * testing at this level: writing goes through a signature check, so the pubkey
 * that must hold a ticket is one the author has proved they control. Reading is
 * a product boundary (see `room-access.ts`), enforced in the UI.
 *
 * Free posting throughout — `PAID_POSTING` stays off here — so what is under
 * test is the door and nothing else.
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
import { ROOT_TICKER } from "@/lib/ticker";
import { createPost, getRoomAccess } from "./actions";

/** A fresh key per author — `createPost` rate-limits per pubkey. */
function who() {
  const key = PrivateKey.fromRandom();
  return { key, pubkey: key.toPublicKey().toString() };
}

type Who = ReturnType<typeof who>;

async function post(me: Who, content: string, parentId?: number) {
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_room");
  fd.set("pubkey", me.pubkey);
  fd.set(
    "signature",
    me.key.sign(Array.from(new TextEncoder().encode(content))).toDER("hex") as string
  );
  if (parentId !== undefined) fd.set("parent_id", String(parentId));
  return createPost(fd);
}

function lastId(): number {
  return (db.prepare("SELECT MAX(id) as id FROM posts").get() as { id: number }).id;
}

beforeEach(() => {
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM tickers");
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM posts");
  vi.clearAllMocks();
});

describe("the room gate", () => {
  it("keeps a stranger out of a named thread", async () => {
    const founder = who();
    expect((await post(founder, "starting $Occam")).ok).toBe(true);
    const rootId = lastId();

    expect(await post(who(), "let me in", rootId)).toEqual({
      ok: false,
      reason: "room_ticket_required",
    });
    // Nothing was stored — the refusal happens before the insert.
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 1 });
  });

  it("lets the founder speak — naming a word gave them a unit of it", async () => {
    const founder = who();
    await post(founder, "starting $Occam");
    const rootId = lastId();
    expect((await post(founder, "my own room", rootId)).ok).toBe(true);
  });

  it("lets a ticket holder in", async () => {
    const founder = who();
    await post(founder, "starting $Occam");
    const rootId = lastId();

    // Buying is a ROOT post, so the door never blocks the purchase itself.
    const buyer = who();
    expect((await post(buyer, "/buy 1 $Occam")).ok).toBe(true);
    expect((await post(buyer, "now I'm in", rootId)).ok).toBe(true);
  });

  it("does NOT let a reply that names the ticker buy its own way in", async () => {
    // The check runs BEFORE the post exists. Otherwise the door would open to
    // anybody who typed the room's name, and the ticket would be free.
    const founder = who();
    await post(founder, "starting $Occam");
    const rootId = lastId();

    expect(await post(who(), "hello $Occam, I belong here", rootId)).toEqual({
      ok: false,
      reason: "room_ticket_required",
    });
  });

  it("leaves an unnamed thread open to everyone", async () => {
    const author = who();
    await post(author, "just a thought, no ticker");
    const rootId = lastId();
    expect((await post(who(), "anyone can reply", rootId)).ok).toBe(true);
  });

  it("NEVER gates the board's own thread", async () => {
    const founder = who();
    await post(founder, `the board itself $${ROOT_TICKER}`);
    const rootId = lastId();
    expect((await post(who(), "the front door is open", rootId)).ok).toBe(true);
  });

  it("reports the door's price and whether the reader holds a ticket", async () => {
    const founder = who();
    await post(founder, "starting $Occam");
    const rootId = lastId();

    const stranger = await getRoomAccess(rootId, who().pubkey);
    expect(stranger.symbol).toBe("OCCAM");
    expect(stranger.gated).toBe(true);
    expect(stranger.held).toBe(0);
    // Supply is 1 (the founding mention), so the next unit is the second.
    expect(stranger.priceSats).toBeGreaterThan(0);

    expect((await getRoomAccess(rootId, founder.pubkey)).held).toBe(1);
    expect((await getRoomAccess(rootId, null)).held).toBe(0);
  });
});
