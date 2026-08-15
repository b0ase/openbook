/**
 * The compose-box ticker hint's denominator.
 *
 * This is the disclosure that tells a founding act apart from a citation before
 * the send button is pressed, so the figure beside it has to agree with the
 * words beside it. It did not: an unclaimed name mentioned in one other thread
 * read `50% · unclaimed — you'd be starting it`.
 */

import { describe, expect, it } from "vitest";
import { formatShare } from "@/lib/share";
import { hintShareTotal } from "./TickerHint";

describe("hintShareTotal", () => {
  it("is WHOLE for an unclaimed name, however many threads mention it", () => {
    // ⚠ The bug this exists for. Mentions are free and confer nothing, so a word
    // used elsewhere cannot dilute a claim nobody has made — and telling someone
    // they are starting a thing while showing them half of it says two opposite
    // things at once.
    for (const threads of [0, 1, 2, 50]) {
      expect(hintShareTotal(false, threads)).toBe(1);
      expect(formatShare(1, hintShareTotal(false, threads))).toBe("100%");
    }
  });

  it("reads saturation for a claimed name", () => {
    // The figure that distinguishes citing an established name from starting one.
    expect(hintShareTotal(true, 5)).toBe(5);
    expect(formatShare(1, hintShareTotal(true, 5))).toBe("20%");
  });

  it("never divides by zero on a claimed name with no recorded usage", () => {
    // The claim itself is a use, so the count should never be 0 — but the hint
    // renders from two separate lookups, and it must not print NaN if they
    // momentarily disagree.
    expect(hintShareTotal(true, 0)).toBe(1);
    expect(formatShare(1, hintShareTotal(true, 0))).toBe("100%");
  });
});
