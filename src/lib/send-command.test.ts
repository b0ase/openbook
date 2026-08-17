/**
 * `/send` — weighted toward what must NOT parse.
 *
 * ⚠ THE ASYMMETRY THAT SHAPES THIS SUITE. A misparsed `/buy` costs the buyer money
 * they chose to spend. A misparsed `/send` gives their property to the wrong
 * person, irreversibly, with no payment coming back and nobody to appeal to. So
 * the tests that matter are the refusals: a near-miss must become an ordinary post
 * rather than a guess at what somebody meant.
 */

import { describe, expect, it } from "vitest";
import { isSendCommand, MAX_SEND_UNITS, parseSendCommand, sendCommandText } from "./send-command";

const ADDR = "14fRfJ8YCPQUcEtxhdJqchPXeca6NjEQpK";

describe("parseSendCommand — what it accepts", () => {
  it("reads units, symbol and a nym", () => {
    expect(parseSendCommand("/send 3 $Occam @Bob")).toEqual({
      symbol: "OCCAM",
      units: 3,
      recipient: { kind: "nym", value: "BOB" },
    });
  });

  it("defaults to one unit", () => {
    // `/send $Occam @Bob` is the obvious way to hand over a single ticket, and
    // refusing it would be pedantry.
    expect(parseSendCommand("/send $Occam @Bob")).toEqual({
      symbol: "OCCAM",
      units: 1,
      recipient: { kind: "nym", value: "BOB" },
    });
  });

  it("accepts an ADDRESS, because most users have no nym", () => {
    expect(parseSendCommand(`/send 2 $Occam ${ADDR}`)).toEqual({
      symbol: "OCCAM",
      units: 2,
      recipient: { kind: "address", value: ADDR },
    });
  });

  it("canonicalises the symbol and the nym to UPPERCASE", () => {
    // One claim, one nym, whatever case was typed — the same rule `ticker.ts`
    // enforces, and for the same reason: two visually identical recipients would
    // be an impersonation vector.
    const a = parseSendCommand("/send $occam @bob");
    const b = parseSendCommand("/send $OCCAM @BOB");
    expect(a).toEqual(b);
  });

  it("allows separators in the count, where people actually type them", () => {
    expect(parseSendCommand("/send 1,000 $Occam @Bob")?.units).toBe(1000);
    expect(parseSendCommand("/send 1_000 $Occam @Bob")?.units).toBe(1000);
  });

  it("tolerates surrounding whitespace and mixed-case command", () => {
    expect(parseSendCommand("  /SEND 1 $Occam @Bob  ")?.symbol).toBe("OCCAM");
  });

  it("accepts the ceiling and refuses one past it", () => {
    expect(parseSendCommand(`/send ${MAX_SEND_UNITS} $Occam @Bob`)?.units).toBe(MAX_SEND_UNITS);
    expect(parseSendCommand(`/send ${MAX_SEND_UNITS + 1} $Occam @Bob`)).toBeNull();
  });
});

describe("parseSendCommand — what it must REFUSE", () => {
  it("refuses a sentence that merely mentions sending", () => {
    // Would otherwise become a transfer nobody asked for.
    expect(parseSendCommand("/send 1 $Occam to Bob")).toBeNull();
    expect(parseSendCommand("/send a ticket to @Bob")).toBeNull();
    expect(parseSendCommand("I'll /send 1 $Occam @Bob later")).toBeNull();
    expect(parseSendCommand("/send $Occam @Bob please")).toBeNull();
  });

  it("refuses a command with NO recipient", () => {
    // ⚠ The worst possible fallback would be "send to nobody" quietly burning
    // them, or "send to yourself" doing nothing while looking like it worked.
    expect(parseSendCommand("/send 1 $Occam")).toBeNull();
    expect(parseSendCommand("/send $Occam")).toBeNull();
  });

  it("refuses a bare @ or a nym starting with a digit", () => {
    expect(parseSendCommand("/send 1 $Occam @")).toBeNull();
    expect(parseSendCommand("/send 1 $Occam @1Bob")).toBeNull();
  });

  it("refuses a MALFORMED address rather than guessing", () => {
    // Base58 has no 0, O, I or l. A single wrong character is a wallet nobody
    // holds the key to, so this must fall through to being a post.
    expect(parseSendCommand("/send 1 $Occam 14fRfJ8YCPQUcEtxhdJqchPXeca6NjEQp0")).toBeNull();
    expect(parseSendCommand("/send 1 $Occam 14fRfJ8YCPQUcEtxhdJqchPXeca6NjEQpKKKKKKK")).toBeNull();
    expect(parseSendCommand("/send 1 $Occam 24fRfJ8YCPQUcEtxhdJqchPXeca6NjEQpK")).toBeNull();
    expect(parseSendCommand("/send 1 $Occam abc")).toBeNull();
  });

  it("refuses a PUBKEY, which is the field people paste wrongly", () => {
    const pk = `02${"a".repeat(64)}`;
    expect(parseSendCommand(`/send 1 $Occam ${pk}`)).toBeNull();
    expect(parseSendCommand(`/send 1 $Occam @${pk}`)).toBeNull();
  });

  it("refuses two symbols — the ambiguity `@` exists to prevent", () => {
    // Nyms render as `$Bob`, so this is the shape somebody will try. Whose token
    // and which recipient would depend on position, and getting it backwards is
    // irreversible.
    expect(parseSendCommand("/send 1 $Occam $Bob")).toBeNull();
  });

  it("refuses a zero, negative, fractional or separator-only count", () => {
    expect(parseSendCommand("/send 0 $Occam @Bob")).toBeNull();
    expect(parseSendCommand("/send -1 $Occam @Bob")).toBeNull();
    expect(parseSendCommand("/send 1.5 $Occam @Bob")).toBeNull();
    expect(parseSendCommand("/send ,,, $Occam @Bob")).toBeNull();
  });

  it("refuses a missing $ on the token", () => {
    expect(parseSendCommand("/send 1 Occam @Bob")).toBeNull();
  });

  it("is not a buy, and a buy is not a send", () => {
    expect(parseSendCommand("/buy 1 $Occam")).toBeNull();
    expect(parseSendCommand("/sendx 1 $Occam @Bob")).toBeNull();
    expect(parseSendCommand("send 1 $Occam @Bob")).toBeNull();
  });

  it("refuses empty and whitespace input", () => {
    expect(parseSendCommand("")).toBeNull();
    expect(parseSendCommand("   ")).toBeNull();
    expect(parseSendCommand("/send")).toBeNull();
  });
});

describe("sendCommandText", () => {
  it("round-trips through the parser", () => {
    // ⚠ The record IS this string — what was signed, what is inscribed, what the
    // feed shows. If it did not re-parse to the same command the permanent record
    // would describe a different transfer from the one that happened.
    for (const text of ["/send 1 $Occam @Bob", `/send 25 $Memeplex ${ADDR}`]) {
      const parsed = parseSendCommand(text);
      expect(parsed).not.toBeNull();
      if (parsed) expect(parseSendCommand(sendCommandText(parsed))).toEqual(parsed);
    }
  });

  it("writes a nym with @ and an address bare", () => {
    expect(
      sendCommandText({ symbol: "OCCAM", units: 1, recipient: { kind: "nym", value: "BOB" } })
    ).toBe("/send 1 $OCCAM @BOB");
    expect(
      sendCommandText({ symbol: "OCCAM", units: 2, recipient: { kind: "address", value: ADDR } })
    ).toBe(`/send 2 $OCCAM ${ADDR}`);
  });
});

describe("isSendCommand", () => {
  it("agrees with the parser", () => {
    expect(isSendCommand("/send 1 $Occam @Bob")).toBe(true);
    expect(isSendCommand("just a post about $Occam")).toBe(false);
  });
});
