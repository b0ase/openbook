/**
 * The on-chain post record's SHAPE (THREADS.md step 5).
 *
 * This is the one place in the codebase where a mistake cannot be corrected by a
 * later deploy: an OP_RETURN is immutable, so a post anchored without its thread
 * pointers is unthreadable from the chain forever. These tests pin the payload
 * bytes rather than the function's return value.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildAndBroadcast = vi.fn();

vi.mock("./wallet", () => ({
  buildAndBroadcast: (...args: unknown[]) => mockBuildAndBroadcast(...args),
}));

import { logPostOnChain } from "./onchain";

/** Pull the JSON back out of the OP_FALSE OP_RETURN script that was broadcast. */
function broadcastRecord(): Record<string, unknown> {
  const outputs = mockBuildAndBroadcast.mock.calls[0][0] as {
    lockingScript: { chunks: { data?: number[] }[] };
  }[];
  // chunks: [OP_FALSE, OP_RETURN, <pushdata>]
  const data = outputs[0].lockingScript.chunks[2].data as number[];
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
}

const ROOT = {
  id: 41,
  content: "a new thread",
  author: "anon_ab12",
  signature: "3045sig",
  pubkey: "02pub",
  parent: null,
};

beforeEach(() => {
  mockBuildAndBroadcast.mockReset();
  mockBuildAndBroadcast.mockResolvedValue({ status: "success", txid: "txid_ok" });
});

describe("logPostOnChain — record shape", () => {
  it("carries the post's own id, so a parent pointer is resolvable", async () => {
    // Without this, `parent: 41` names a row no chain reader can locate and the
    // thread graph stays reconstructible only from SQLite.
    await logPostOnChain(ROOT);
    expect(broadcastRecord().id).toBe(41);
  });

  it("writes parent: null for a root — explicitly, not by omission", async () => {
    // An omitted key would be indistinguishable from a pre-threading record.
    await logPostOnChain(ROOT);
    const record = broadcastRecord();
    expect(record).toHaveProperty("parent");
    expect(record.parent).toBeNull();
  });

  it("carries the parent id for a reply", async () => {
    await logPostOnChain({ ...ROOT, id: 42, parent: 41 });
    expect(broadcastRecord().parent).toBe(41);
  });

  it("keeps the envelope at v:1 — id and parent are additive fields", async () => {
    // Per the reader contract in lib/onchain-record.ts, adding optional fields
    // does NOT bump v. Bumping it here would orphan every reader of the 2,006
    // already-anchored genesis records.
    await logPostOnChain(ROOT);
    const record = broadcastRecord();
    expect(record.v).toBe(1);
    expect(record.type).toBe("post");
  });

  it("still carries the pre-threading fields unchanged", async () => {
    await logPostOnChain(ROOT);
    expect(broadcastRecord()).toMatchObject({
      content: "a new thread",
      author: "anon_ab12",
      sig: "3045sig",
      pubkey: "02pub",
    });
  });

  it("preserves an unsigned post's null sig/pubkey", async () => {
    await logPostOnChain({ ...ROOT, signature: null, pubkey: null });
    const record = broadcastRecord();
    expect(record.sig).toBeNull();
    expect(record.pubkey).toBeNull();
  });
});
