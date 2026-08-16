import { describe, expect, it } from "vitest";
import { identityColor, identityHue, identityTextColor } from "./identity-color";

/** The bands that carry meaning elsewhere in the UI, and their tolerance. */
const RESERVED: Array<[string, number, number]> = [
  ["red / warning", 0, 12],
  ["amber / claimed name", 38, 14],
  ["emerald / signed + on chain", 152, 14],
];

/** Circular distance between two hues in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const PUBKEY_A = "026ba10b1c3a01eb12338f767f80ccb7a1e67bf301d9285f6569c67ea52d1b125b";
const PUBKEY_B = "03aa11b21c3a01eb12338f767f80ccb7a1e67bf301d9285f6569c67ea52d1b1000";

describe("identityColor", () => {
  it("is stable for the same seed", () => {
    expect(identityColor(PUBKEY_A)).toBe(identityColor(PUBKEY_A));
    expect(identityHue(PUBKEY_A)).toBe(identityHue(PUBKEY_A));
  });

  it("returns a usable CSS colour", () => {
    expect(identityColor(PUBKEY_A)).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    expect(identityTextColor(PUBKEY_A)).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });

  it("gives the handle and the body text the same hue", () => {
    // The tint has to read as the SAME person as the handle above it.
    const hue = identityHue(PUBKEY_A);
    expect(identityColor(PUBKEY_A)).toContain(`hsl(${hue} `);
    expect(identityTextColor(PUBKEY_A)).toContain(`hsl(${hue} `);
  });

  it("sets the body tint closer to the page text than the handle", () => {
    // Paragraphs must stay readable; only the handle is allowed to shout.
    const sat = (c: string) => Number(c.match(/ (\d+)% /)?.[1]);
    expect(sat(identityTextColor(PUBKEY_A))).toBeLessThan(sat(identityColor(PUBKEY_A)));
  });

  // The whole point of the palette. If someone widens HUES without thinking,
  // this is what stops an identity from being coloured like a status badge.
  it.each(RESERVED)("never lands on the %s band", (_label, centre, tolerance) => {
    for (let i = 0; i < 400; i++) {
      const hue = identityHue(`pubkey-fixture-${i}`);
      expect(hueGap(hue, centre)).toBeGreaterThan(tolerance);
    }
  });

  it("separates neighbouring hues enough to tell apart at 12px", () => {
    const hues = [...new Set(Array.from({ length: 400 }, (_, i) => identityHue(`seed-${i}`)))].sort(
      (a, b) => a - b
    );
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(18);
    }
  });

  it("spreads distinct identities across the palette", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => identityHue(`author-${i}`)));
    // A hash that collapsed everyone onto one colour would defeat the feature.
    expect(seen.size).toBeGreaterThan(5);
  });

  it("gives two different pubkeys different colours", () => {
    expect(identityHue(PUBKEY_A)).not.toBe(identityHue(PUBKEY_B));
  });

  it("falls back to a valid colour for a missing seed", () => {
    // Pre-signature genesis posts have no pubkey and must still render.
    for (const empty of [null, undefined, ""]) {
      expect(identityColor(empty)).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    }
  });
});
