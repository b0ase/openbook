/**
 * Post pricing — flat cost-plus.
 *
 * The assertions that matter are the ones about MONEY LEAVING: that we never
 * quote an output nobody can spend, and that the price does not climb with
 * supply (which is the whole point of the receipt model).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  FEE_RATE_SATS_PER_KB,
  feeRateFromPolicy,
  INSCRIPTION_SATS,
  isPaidPostingEnabled,
  MIN_ECONOMIC_OUTPUT_SATS,
  postPrice,
} from "./post-economics";

afterEach(() => {
  process.env.POST_MARKUP_PERCENT = undefined;
  process.env.PAID_POSTING = undefined;
});

describe("postPrice", () => {
  it("charges the miner for the whole transaction, not just the payload", () => {
    const p = postPrice(1000);
    expect(p.networkFeeSats).toBe(FEE_RATE_SATS_PER_KB);
  });

  it("always rounds the network fee UP", () => {
    // Rounding down means the operator quietly funds the difference on every
    // single post.
    expect(postPrice(1).networkFeeSats).toBe(1);
    expect(postPrice(1001).networkFeeSats).toBeGreaterThan(FEE_RATE_SATS_PER_KB);
  });

  it("totals to exactly its parts", () => {
    const p = postPrice(500);
    expect(p.totalSats).toBe(p.networkFeeSats + p.inscriptionSats + p.platformFeeSats);
    expect(p.inscriptionSats).toBe(INSCRIPTION_SATS);
  });

  it("NEVER quotes a platform fee below the economic floor", () => {
    // ⚠ The load-bearing one. A percentage of a fraction of a penny rounds to
    // 1-2 sats, and an output worth less than its own spending cost is worse
    // than no output at all.
    for (const bytes of [1, 10, 100, 250, 500]) {
      const p = postPrice(bytes, { markupPercent: 10 });
      expect(p.platformFeeSats).toBeGreaterThanOrEqual(MIN_ECONOMIC_OUTPUT_SATS);
    }
  });

  it("says when the floor raised the markup above the configured percentage", () => {
    // Surfaced, not silent: the operator should see that a small post's
    // effective markup is not the 10% they set.
    const small = postPrice(100, { markupPercent: 10 });
    expect(small.floored).toBe(true);

    const large = postPrice(20_000, { markupPercent: 10 });
    expect(large.floored).toBe(false);
    expect(large.platformFeeSats).toBeGreaterThan(MIN_ECONOMIC_OUTPUT_SATS);
  });

  it("takes NOTHING at a zero markup — at-cost is legal", () => {
    const p = postPrice(1000, { markupPercent: 0 });
    expect(p.platformFeeSats).toBe(0);
    expect(p.floored).toBe(false);
    expect(p.totalSats).toBe(p.networkFeeSats + INSCRIPTION_SATS);
  });

  it("does NOT rise with supply — the same size always costs the same", () => {
    // The receipt model in one assertion: there is no curve, so a popular name
    // is no more expensive to mint into than an unused one, and no resale market
    // can detach upward from a price that never moves.
    const first = postPrice(800);
    const thousandth = postPrice(800);
    expect(thousandth).toEqual(first);
  });

  it("scales the markup with cost once the percentage clears the floor", () => {
    const small = postPrice(5_000, { markupPercent: 10 });
    const big = postPrice(50_000, { markupPercent: 10 });
    expect(big.platformFeeSats).toBeGreaterThan(small.platformFeeSats);
  });

  it("reads the markup from the environment, and ignores nonsense", () => {
    process.env.POST_MARKUP_PERCENT = "25";
    expect(postPrice(20_000).platformFeeSats).toBe(
      postPrice(20_000, { markupPercent: 25 }).platformFeeSats
    );

    for (const bad of ["", "abc", "-5"]) {
      process.env.POST_MARKUP_PERCENT = bad;
      expect(postPrice(20_000).platformFeeSats).toBe(
        postPrice(20_000, { markupPercent: 10 }).platformFeeSats
      );
    }
  });

  it("treats junk sizes as zero rather than producing a negative price", () => {
    expect(postPrice(-100).networkFeeSats).toBe(0);
    expect(postPrice(Number.NaN).networkFeeSats).toBe(0);
  });
});

describe("postPrice with a mint charge", () => {
  // The curve is charged (DECISIONS.md, 2026-08-16). What matters here is that
  // it reaches the OUTPUT the builder funds — a mint charge that lands in the
  // total but not in `platformOutputSats` would broadcast underpaid.
  it("adds the mint to the platform OUTPUT, not just the total", () => {
    const flat = postPrice(500, { markupPercent: 10 });
    const withMint = postPrice(500, { markupPercent: 10, mintSats: 339 });
    expect(withMint.mintSats).toBe(339);
    expect(withMint.platformFeeSats).toBe(flat.platformFeeSats);
    expect(withMint.platformOutputSats).toBe(flat.platformFeeSats + 339);
    expect(withMint.totalSats).toBe(flat.totalSats + 339);
  });

  it("is zero for a post that names no ticker — most posts", () => {
    const p = postPrice(500, { markupPercent: 10 });
    expect(p.mintSats).toBe(0);
    expect(p.platformOutputSats).toBe(p.platformFeeSats);
  });

  it("still pays the mint at a 0% markup — at-cost is not free minting", () => {
    const p = postPrice(500, { markupPercent: 0, mintSats: 113 });
    expect(p.platformFeeSats).toBe(0);
    expect(p.platformOutputSats).toBe(113);
  });

  it("clamps junk rather than carrying it into an output amount", () => {
    expect(postPrice(500, { mintSats: Number.NaN }).mintSats).toBe(0);
    expect(postPrice(500, { mintSats: -50 }).mintSats).toBe(0);
    expect(postPrice(500, { mintSats: 12.4 }).mintSats).toBe(13);
  });
});

describe("isPaidPostingEnabled", () => {
  it("is OFF unless explicitly switched on", () => {
    // ⚠ Default-off is the safety property: the inscription envelope has never
    // been confirmed by a live indexer, so charging for it by default would
    // sell tokens that might not be indexed as tokens.
    process.env.PAID_POSTING = undefined;
    expect(isPaidPostingEnabled()).toBe(false);
    for (const off of ["", "no", "off", "0", "false", "yes-please"]) {
      process.env.PAID_POSTING = off;
      expect(isPaidPostingEnabled()).toBe(false);
    }
  });

  it("accepts only true/1", () => {
    for (const on of ["true", "TRUE", "1", " true "]) {
      process.env.PAID_POSTING = on;
      expect(isPaidPostingEnabled()).toBe(true);
    }
  });
});

describe("feeRateFromPolicy", () => {
  it("reads the live ARC policy shape", () => {
    // The exact response measured from arc.gorillapool.io/v1/policy.
    expect(feeRateFromPolicy({ policy: { miningFee: { bytes: 1000, satoshis: 100 } } })).toBe(100);
  });

  it("ROUNDS UP — one sat/kB under the floor is a rejection, not a discount", () => {
    // And under paid posting a rejection lands AFTER the author committed.
    expect(feeRateFromPolicy({ policy: { miningFee: { bytes: 3000, satoshis: 100 } } })).toBe(34);
    expect(feeRateFromPolicy({ policy: { miningFee: { bytes: 1000, satoshis: 1 } } })).toBe(1);
  });

  it("never returns zero, even if a miner publishes a free policy", () => {
    expect(feeRateFromPolicy({ policy: { miningFee: { bytes: 1000, satoshis: 0 } } })).toBe(1);
  });

  it("returns null for anything malformed rather than guessing", () => {
    // A guessed rate is worse than the fallback: it could be below the floor.
    for (const bad of [
      null,
      {},
      { policy: {} },
      { policy: { miningFee: {} } },
      { policy: { miningFee: { bytes: 0, satoshis: 100 } } },
      { policy: { miningFee: { bytes: "1000", satoshis: 100 } } },
      { policy: { miningFee: { bytes: 1000, satoshis: -5 } } },
      { policy: { miningFee: { bytes: Number.NaN, satoshis: 100 } } },
    ]) {
      expect(feeRateFromPolicy(bad)).toBeNull();
    }
  });
});

describe("postPrice fee rate", () => {
  it("uses a supplied live rate over the hardcoded fallback", () => {
    expect(postPrice(1000, { feeRateSatsPerKb: 100 }).networkFeeSats).toBe(100);
    expect(postPrice(1000).networkFeeSats).toBe(FEE_RATE_SATS_PER_KB);
  });

  it("ignores a nonsense rate instead of pricing at zero", () => {
    expect(postPrice(1000, { feeRateSatsPerKb: Number.NaN }).networkFeeSats).toBe(
      FEE_RATE_SATS_PER_KB
    );
    expect(postPrice(1000, { feeRateSatsPerKb: 0 }).networkFeeSats).toBe(1);
  });
});
