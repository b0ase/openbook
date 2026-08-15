/**
 * Which ticker mentions print a share figure inside a post's prose.
 *
 * The figure interrupts a sentence somebody wrote, so the tests are about where
 * it stays OUT of the way. The case that prompted them, rendered live:
 *
 *   A $ticker (100%) contains lots of things. In business, a $ticker (100%) is
 *   the shorthand for a company's value…
 *
 * — the same uninformative number, twice, mid-sentence.
 */

import { describe, expect, it } from "vitest";
import { findSegments } from "@/lib/linkify";
import { figuredOffsets } from "./PostText";

const offsets = (content: string, supply?: Record<string, number>) => [
  ...figuredOffsets(findSegments(content), supply),
];

describe("figuredOffsets", () => {
  it("says NOTHING about a name only this post holds", () => {
    // ⚠ Every new name is 100%. The figure is pure interruption there, and the
    // wallet already reports sole holdings as `1-of-1`.
    expect(offsets("A $ticker contains lots of things", { TICKER: 1 })).toEqual([]);
  });

  it("prints a shared name ONCE, at its first mention", () => {
    // Supply is counted per POST, so repeating the word cannot change the
    // number — printing it again is the same figure a second time.
    const content = "A $ticker contains lots. In business, a $ticker is shorthand.";
    const marks = offsets(content, { TICKER: 4 });
    expect(marks).toHaveLength(1);
    expect(marks[0]).toBe(content.indexOf("$ticker"));
  });

  it("treats each distinct name on its own merits", () => {
    const content = "$Memeplex and $Words and $Memeplex again";
    const marks = offsets(content, { MEMEPLEX: 5, WORDS: 1 });
    // MEMEPLEX once (shared, first mention); WORDS never (sole holding).
    expect(marks).toEqual([content.indexOf("$Memeplex")]);
  });

  it("prints nothing when supply is unknown", () => {
    // An absent figure is a name whose supply has not loaded, or one nobody has
    // claimed. Inventing a number for either would be worse than the silence.
    expect(offsets("$Ticker and $Words")).toEqual([]);
    expect(offsets("$Ticker", {})).toEqual([]);
    expect(offsets("$Ticker", { TICKER: 0 })).toEqual([]);
  });

  it("ignores URLs, which share the segment list with tickers", () => {
    expect(offsets("see https://example.com/$ticker", { TICKER: 9 })).toEqual([]);
  });
});
