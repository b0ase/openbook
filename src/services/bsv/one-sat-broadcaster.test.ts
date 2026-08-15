/**
 * Response mapping for the ordinals broadcast endpoint.
 *
 * This is the code that decides whether the caller believes a transaction was
 * broadcast — and under paid posting the answer becomes a post's permanent
 * on-chain identity. A wrong "success" is unrecoverable, so the tests lean on
 * the ways a 200 can still not be a broadcast.
 */

import { describe, expect, it } from "vitest";
import { mapOneSatResponse, ONE_SAT_BROADCAST_URL } from "./one-sat-broadcaster";

const TXID = "a".repeat(64);

describe("mapOneSatResponse", () => {
  it("reads the txid straight out of a successful body", () => {
    expect(mapOneSatResponse(true, 200, TXID)).toEqual({
      status: "success",
      txid: TXID,
      message: "broadcast successful",
    });
  });

  it("tolerates surrounding whitespace", () => {
    const r = mapOneSatResponse(true, 200, `\n${TXID}\n`);
    expect(r.status).toBe("success");
  });

  it("REFUSES a 200 that is not a transaction id", () => {
    // ⚠ The dangerous case. A proxy, a captive portal or an error page can
    // answer 200 with HTML; trusting it would record that page as the post's
    // permanent identity, and a post cannot be re-identified afterwards.
    for (const body of ["<!doctype html><html>…", "", "ok", "null", { txid: TXID }, 42]) {
      const r = mapOneSatResponse(true, 200, body);
      expect(r.status).toBe("error");
      expect(r.status === "error" && r.code).toBe("BAD_TXID");
    }
  });

  it("surfaces the endpoint's own message on failure", () => {
    expect(mapOneSatResponse(false, 400, { message: "txn-mempool-conflict" })).toEqual({
      status: "error",
      code: "400",
      description: "txn-mempool-conflict",
    });
  });

  it("falls back to the raw body, then to a generic reason", () => {
    expect(
      mapOneSatResponse(false, 503, "upstream unavailable") as { description: string }
    ).toMatchObject({ description: "upstream unavailable" });
    expect(mapOneSatResponse(false, 500, {}) as { description: string }).toMatchObject({
      description: "Broadcast rejected",
    });
    expect(mapOneSatResponse(false, 0, null) as { code: string }).toMatchObject({
      code: "ERR_UNKNOWN",
    });
  });
});

describe("ONE_SAT_BROADCAST_URL", () => {
  it("targets the ordinals endpoint, which is what feeds the indexer", () => {
    // Plain ARC would mine the transaction just as well; this URL is the reason
    // the inscription is INDEXED promptly rather than eventually.
    expect(ONE_SAT_BROADCAST_URL).toBe("https://ordinals.gorillapool.io/api/tx");
  });
});
