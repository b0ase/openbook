/**
 * The overlay client.
 *
 * ⚠ WHAT THESE ARE GUARDING. Every test here is one shape of the same bug: the
 * indexer failing to answer, and the app writing that down as "you own nothing".
 * A room gate reads these numbers, so a wrong zero is a paying member standing
 * outside a door they bought. None of the failures worth catching throw.
 */

import { describe, expect, it } from "vitest";
import { combinedBalance, interpretBalance, isTokenId, LOCK_TYPE } from "./overlay";

const TOKEN = `${"a".repeat(64)}_0`;

describe("interpretBalance", () => {
  it("reads a real answer", () => {
    expect(interpretBalance(200, { balance: 7, utxoCount: 2 })).toEqual({
      status: "ok",
      units: 7,
      utxoCount: 2,
    });
  });

  it("keeps a genuine zero as a zero", () => {
    // The point of the union is not that zero is suspicious — it is that only
    // an ANSWERED zero counts. This one was answered.
    expect(interpretBalance(200, { balance: 0, utxoCount: 0 })).toEqual({
      status: "ok",
      units: 0,
      utxoCount: 0,
    });
  });

  it("calls an untracked token notIndexed, NOT zero", () => {
    // 503 "Topic not available" means the overlay has never been told about the
    // token. Its holders exist; this service cannot see them.
    expect(interpretBalance(503, { message: "Topic not available" })).toEqual({
      status: "notIndexed",
    });
  });

  it("calls a 500 unknown, NOT zero", () => {
    // Observed live on both whitelisted test tokens: `Failed to retrieve token
    // details`. Tracked, but no data yet.
    const r = interpretBalance(500, { message: "Failed to retrieve token details" });
    expect(r.status).toBe("unknown");
  });

  it("refuses a balance that is not a number", () => {
    // ⚠ The tempting bug: `Number(undefined)` is NaN, and a careless `|| 0`
    // turns every malformed response into an empty wallet.
    // ⚠ EVERY ONE OF THESE IS ZERO UNDER A BARE `Number(raw)`. `Number(null)`,
    // `Number("")` and `Number(false)` are all 0 — finite, non-negative, and
    // indistinguishable from a real empty wallet. The first version of this
    // file had exactly that bug and this loop is what found it.
    for (const body of [
      {},
      { balance: null },
      { balance: "" },
      { balance: false },
      { balance: "many" },
      null,
    ]) {
      expect(interpretBalance(200, body).status).toBe("unknown");
    }
  });

  it("refuses a negative balance", () => {
    expect(interpretBalance(200, { balance: -1 }).status).toBe("unknown");
  });

  it("accepts a numeric string, because JSON bigints arrive as strings", () => {
    expect(interpretBalance(200, { balance: "21000000", utxoCount: "1" })).toEqual({
      status: "ok",
      units: 21_000_000,
      utxoCount: 1,
    });
  });
});

describe("isTokenId", () => {
  it("accepts a deploy outpoint and rejects everything else", () => {
    expect(isTokenId(TOKEN)).toBe(true);
    expect(isTokenId(`${"A".repeat(64)}_0`)).toBe(false); // uppercase is not the id we store
    expect(isTokenId("a".repeat(64))).toBe(false); // no vout
    expect(isTokenId(`${"a".repeat(63)}_0`)).toBe(false); // short txid
    expect(isTokenId("../../etc/passwd")).toBe(false);
    expect(isTokenId("")).toBe(false);
  });
});

describe("combinedBalance", () => {
  it("refuses a malformed token id before it reaches a URL", async () => {
    const r = await combinedBalance("not-a-token", ["1abc"]);
    expect(r.status).toBe("unknown");
  });

  it("refuses more than the route accepts, as our error not a 400", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `addr${i}`);
    const r = await combinedBalance(TOKEN, many);
    expect(r).toEqual({ status: "unknown", reason: "more than 100 addresses" });
  });

  it("refuses an empty list rather than asking for nothing", async () => {
    expect((await combinedBalance(TOKEN, [])).status).toBe("unknown");
  });
});

describe("the lock type", () => {
  it("is p2pkh, which is the only one indexed by address", () => {
    // `lookups/bsv21-events-lookup.go` emits `p2pkh:<address>:<id>` and nothing
    // else. Change this and every balance silently reads zero — the exact
    // failure this file exists to prevent.
    expect(LOCK_TYPE).toBe("p2pkh");
  });
});
