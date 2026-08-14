import { describe, expect, it } from "vitest";
import { formatShare } from "./share";

describe("formatShare", () => {
  it("writes a whole percentage without decimals at the top of the range", () => {
    expect(formatShare(1, 1)).toBe("100%");
    expect(formatShare(1, 2)).toBe("50%");
    expect(formatShare(1, 10)).toBe("10%");
  });

  it("adds precision as the share gets smaller", () => {
    expect(formatShare(1, 20)).toBe("5.0%");
    expect(formatShare(1, 200)).toBe("0.50%");
    expect(formatShare(1, 2000)).toBe("0.050%");
  });

  it("never prints 0% for a holding that exists", () => {
    // "0%" reads as "you have nothing", which is the one wrong answer here.
    expect(formatShare(1, 100_000)).toBe("<0.01%");
    expect(formatShare(1, 1_000_000)).toBe("<0.01%");
  });

  it("returns 0% only for an actual zero holding", () => {
    expect(formatShare(0, 100)).toBe("0%");
  });

  it("refuses to divide by an empty or impossible thread", () => {
    // A thread with no posts cannot be the denominator of anyone's share.
    expect(formatShare(1, 0)).toBe("0%");
    expect(formatShare(1, -5)).toBe("0%");
    expect(formatShare(Number.NaN, 10)).toBe("0%");
    expect(formatShare(1, Number.POSITIVE_INFINITY)).toBe("0%");
  });
});
