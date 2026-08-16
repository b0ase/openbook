import { describe, expect, it } from "vitest";
import { MINT_BASE_SATS, mintCostForRange, mintPriceSats } from "./mint-price";

describe("mintPriceSats", () => {
  it("prices the first unit at cost and adds one slope per unit after", () => {
    expect(mintPriceSats(0)).toBe(MINT_BASE_SATS);
    expect(mintPriceSats(1)).toBe(2 * MINT_BASE_SATS);
    expect(mintPriceSats(9)).toBe(10 * MINT_BASE_SATS);
  });

  it("rises — which is what makes an early seat appreciate", () => {
    // A unit minted at supply 0 is worth up to the price of minting at supply
    // 5,000, because that is the alternative cost of getting in.
    expect(mintPriceSats(5_000)).toBeGreaterThan(mintPriceSats(0));
  });

  it("is LINEAR, not exponential — a popular name stays buyable", () => {
    const step = mintPriceSats(101) - mintPriceSats(100);
    expect(mintPriceSats(1_001) - mintPriceSats(1_000)).toBe(step);
  });

  it("treats junk supply as zero rather than throwing", () => {
    expect(mintPriceSats(-5)).toBe(MINT_BASE_SATS);
    expect(mintPriceSats(Number.NaN)).toBe(MINT_BASE_SATS);
    expect(mintPriceSats(2.7)).toBe(3 * MINT_BASE_SATS);
  });
});

describe("mintCostForRange", () => {
  it("is quadratic in total, which is what makes cornering a name expensive", () => {
    // 1+2+3 = 6 units of base from an empty supply.
    expect(mintCostForRange(0, 3)).toBe(6 * MINT_BASE_SATS);
  });

  it("costs more to buy the same number of units later", () => {
    expect(mintCostForRange(1_000, 10)).toBeGreaterThan(mintCostForRange(0, 10));
  });

  it("is zero for no units", () => {
    expect(mintCostForRange(50, 0)).toBe(0);
  });
});
