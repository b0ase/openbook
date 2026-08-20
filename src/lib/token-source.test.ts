/**
 * Where a balance comes from.
 *
 * ⚠ THE FAILURE THIS GUARDS IS A SENTENCE, NOT A CRASH. "You own 3 units"
 * means two different things depending on whether Bitcoin or our database is
 * guaranteeing it, and the published position is that balances are provisional
 * until the first is true. Every test here is a way that distinction could be
 * quietly lost.
 */

import { describe, expect, it } from "vitest";
import type { TokenBalance } from "@/services/indexer/overlay";
import { decideSource, type TickerContract } from "./token-source";

const CONTRACT: TickerContract = {
  symbol: "OCCAM",
  tokenId: `${"a".repeat(64)}_0`,
  contractOutpoint: `${"a".repeat(64)}_0`,
  basePrice: 113,
  maxSupply: "21000000",
  deployedAt: "2026-08-20 00:00:00",
  whitelistedAt: null,
};

describe("decideSource", () => {
  it("labels a ledger-only word as database, not as a chain fact", () => {
    // No contract deployed: our record is the ONLY answer, and it says so.
    expect(decideSource(null, null, 3)).toEqual({ source: "database", units: 3 });
  });

  it("prefers the chain once a contract exists", () => {
    const chain: TokenBalance = { status: "ok", units: 7, utxoCount: 2 };
    expect(decideSource(CONTRACT, chain, 3)).toEqual({
      source: "chain",
      units: 7,
      tokenId: CONTRACT.tokenId,
    });
  });

  it("reports a chain zero as a chain zero", () => {
    // An ANSWERED zero is a real fact and must not be second-guessed with the
    // database figure — that would resurrect units the chain says are gone.
    const chain: TokenBalance = { status: "ok", units: 0, utxoCount: 0 };
    expect(decideSource(CONTRACT, chain, 5)).toEqual({
      source: "chain",
      units: 0,
      tokenId: CONTRACT.tokenId,
    });
  });

  it("does NOT fall back to the database when the indexer has never seen the token", () => {
    // ⚠ The tempting bug. Returning `{source:"database", units:3}` here would
    // present our record as though we had read the chain. The token is real;
    // we simply never asked our overlay to watch it.
    expect(decideSource(CONTRACT, { status: "notIndexed" }, 3)).toEqual({
      source: "unknown",
      tokenId: CONTRACT.tokenId,
      reason: "not_indexed",
    });
  });

  it("does NOT fall back to the database when the indexer is unreachable", () => {
    expect(decideSource(CONTRACT, { status: "unknown", reason: "timeout" }, 3)).toEqual({
      source: "unknown",
      tokenId: CONTRACT.tokenId,
      reason: "unreachable",
    });
  });

  it("treats a missing reply as unreachable, never as zero", () => {
    // A thrown request resolves to null upstream. Zero here would lock a paying
    // member out of a room they own.
    expect(decideSource(CONTRACT, null, 3)).toEqual({
      source: "unknown",
      tokenId: CONTRACT.tokenId,
      reason: "unreachable",
    });
  });

  it("never returns a bare number for any input", () => {
    // The module's whole purpose: provenance travels with the figure.
    const cases: Array<TokenBalance | null> = [
      null,
      { status: "ok", units: 1, utxoCount: 1 },
      { status: "notIndexed" },
      { status: "unknown", reason: "x" },
    ];
    for (const c of cases) {
      for (const contract of [null, CONTRACT]) {
        const r = decideSource(contract, c, 9);
        expect(["chain", "database", "unknown"]).toContain(r.source);
      }
    }
  });
});
