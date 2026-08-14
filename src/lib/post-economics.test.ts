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
