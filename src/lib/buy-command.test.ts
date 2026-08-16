import { describe, expect, it } from "vitest";
import { buyCommandText, isBuyCommand, MAX_BUY_UNITS, parseBuyCommand } from "./buy-command";

describe("parseBuyCommand", () => {
  it("reads a count and a symbol", () => {
    expect(parseBuyCommand("/buy 1000 $Memeplex")).toEqual({ symbol: "MEMEPLEX", units: 1000 });
  });

  it("defaults to one unit", () => {
    expect(parseBuyCommand("/buy $Memeplex")).toEqual({ symbol: "MEMEPLEX", units: 1 });
  });

  it("canonicalises the symbol, because a claim is case-insensitive", () => {
    expect(parseBuyCommand("/buy 2 $memeplex")?.symbol).toBe("MEMEPLEX");
    expect(parseBuyCommand("/BUY 2 $MemePlex")?.symbol).toBe("MEMEPLEX");
  });

  it("accepts the separators people actually type in a four-digit number", () => {
    expect(parseBuyCommand("/buy 1,000 $A")?.units).toBe(1000);
    expect(parseBuyCommand("/buy 1_000 $A")?.units).toBe(1000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseBuyCommand("  /buy 5 $A  ")).toEqual({ symbol: "A", units: 5 });
  });

  /**
   * ⚠ EVERYTHING BELOW MUST NOT PARSE. This command spends money, so ambiguity
   * has to resolve toward "this is an ordinary post" — the same rule the ticker
   * parser follows, for the same reason.
   */
  it.each([
    ["a sentence that starts with the word", "/buy some stuff"],
    ["no symbol at all", "/buy 100"],
    ["no dollar sign", "/buy 100 MEMEPLEX"],
    ["two symbols — which one is being bought?", "/buy 10 $A $B"],
    ["trailing prose that would be silently dropped", "/buy 10 $A for the room"],
    ["leading prose", "I think I will /buy 10 $A"],
    ["a fractional count", "/buy 1.5 $A"],
    ["a negative count", "/buy -5 $A"],
    ["zero units", "/buy 0 $A"],
    ["separators with no digits", "/buy ,, $A"],
    ["a price, not a ticker", "/buy 10 $50"],
    ["a bare slash", "/buy"],
    ["a different command", "/agent what is $A"],
    ["an empty message", ""],
  ])("does not parse: %s", (_why, text) => {
    expect(parseBuyCommand(text)).toBeNull();
  });

  it("refuses an obviously mistyped size rather than pricing it", () => {
    expect(parseBuyCommand(`/buy ${MAX_BUY_UNITS} $A`)?.units).toBe(MAX_BUY_UNITS);
    expect(parseBuyCommand(`/buy ${MAX_BUY_UNITS + 1} $A`)).toBeNull();
    expect(parseBuyCommand("/buy 1000000 $A")).toBeNull();
  });

  it("refuses a symbol the ticker rules reject", () => {
    // 17 characters — over TICKER_MAX_LENGTH.
    expect(parseBuyCommand("/buy 1 $Averyveryverylongname")).toBeNull();
  });
});

describe("isBuyCommand", () => {
  it("agrees with the parser", () => {
    expect(isBuyCommand("/buy 3 $A")).toBe(true);
    expect(isBuyCommand("just a post about $A")).toBe(false);
  });
});

describe("buyCommandText", () => {
  it("round-trips, which is what lets the server re-derive the buy from the record", () => {
    const cmd = { symbol: "MEMEPLEX", units: 1000 };
    expect(buyCommandText(cmd)).toBe("/buy 1000 $MEMEPLEX");
    expect(parseBuyCommand(buyCommandText(cmd))).toEqual(cmd);
  });

  it("normalises what the user typed — the record is canonical, not verbatim", () => {
    const typed = parseBuyCommand("/buy 1,000 $memeplex");
    if (!typed) throw new Error("expected a command");
    expect(buyCommandText(typed)).toBe("/buy 1000 $MEMEPLEX");
  });
});
