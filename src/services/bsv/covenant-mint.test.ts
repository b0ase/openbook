import { OP, Script } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import {
  buildMintUnlockingScript,
  buildTreasuryScript,
  MINT_SIGHASH,
  parseMintUnlockingScript,
  pushScriptNum,
} from "./covenant-mint";

/**
 * ⚠ THE BYTE-EQUALITY PROOF IS IN `contracts/tests/covenantMint.test.ts`, where
 * the compiler is. Everything here is self-consistent by construction, which is
 * exactly what a wrong layout also is. What this covers is the refusals and the
 * encoding boundary — the parts that do not need sCrypt to be meaningful.
 */

const H20 = Array.from({ length: 20 }, (_, i) => i);
const PREIMAGE = [1, 2, 3, 4];

function hexOf(value: bigint): string {
  return pushScriptNum(new Script(), value).toHex();
}

describe("pushScriptNum", () => {
  /**
   * ⚠ THE BOUNDARY A NAIVE BUILDER CROSSES WITHOUT NOTICING. 1..16 are single
   * opcodes; 17 is the first value pushed as data. Both leave the same number
   * on the stack, so a script that gets this wrong evaluates correctly and is
   * still the wrong bytes — and the covenant's own transaction is compared
   * byte-for-byte against sCrypt's.
   */
  it("uses OP_N for 1..16 and data pushes above", () => {
    expect(hexOf(1n)).toBe("51");
    expect(hexOf(16n)).toBe("60");
    expect(hexOf(17n)).toBe("0111");
    expect(hexOf(0n)).toBe("00");
  });

  it("pads a value that would otherwise read as negative", () => {
    // 128 is 0x80 — the sign bit. Same rule as the covenant's supply field.
    expect(hexOf(128n)).toBe("028000");
  });

  it("uses OP_1NEGATE rather than encoding minus one by hand", () => {
    expect(hexOf(-1n)).toBe(String(OP.OP_1NEGATE.toString(16)));
  });
});

describe("buildMintUnlockingScript", () => {
  const valid = {
    amount: 3n,
    minterHash: H20,
    preimage: PREIMAGE,
    changeSats: 500n,
    changeHash: H20,
  };

  it("round-trips through the parser", () => {
    const parsed = parseMintUnlockingScript(buildMintUnlockingScript(valid));
    expect(parsed).toEqual(valid);
  });

  it("emits exactly five pushes, in the compiler's order", () => {
    const chunks = buildMintUnlockingScript(valid).chunks;
    expect(chunks).toHaveLength(5);
    expect(chunks[0].op).toBe(OP.OP_3);
    expect(chunks[1].data).toEqual(H20);
    expect(chunks[2].data).toEqual(PREIMAGE);
    expect(chunks[4].data).toEqual(H20);
  });

  /**
   * ⚠ EVERY ONE OF THESE IS A TRANSACTION THAT WOULD BROADCAST AND FAIL. A
   * malformed unlocking script is not rejected by the network for being
   * malformed — it is rejected by the covenant, after the funder has paid the
   * fee on a 48KB transaction. Refusing here costs nothing.
   */
  it("refuses inputs that would build a doomed transaction", () => {
    expect(() => buildMintUnlockingScript({ ...valid, minterHash: [1, 2] })).toThrow(/20 bytes/);
    expect(() => buildMintUnlockingScript({ ...valid, changeHash: [] })).toThrow(/20 bytes/);
    expect(() => buildMintUnlockingScript({ ...valid, preimage: [] })).toThrow(/preimage/);
    expect(() => buildMintUnlockingScript({ ...valid, amount: 0n })).toThrow(/positive/);
    expect(() => buildMintUnlockingScript({ ...valid, changeSats: -1n })).toThrow(/negative/);
  });

  it("allows zero change — a spend that leaves nothing over is legal", () => {
    const parsed = parseMintUnlockingScript(buildMintUnlockingScript({ ...valid, changeSats: 0n }));
    expect(parsed?.changeSats).toBe(0n);
  });
});

describe("parseMintUnlockingScript", () => {
  it("refuses anything that is not five pushes", () => {
    expect(parseMintUnlockingScript(new Script())).toBeNull();
    expect(parseMintUnlockingScript(Script.fromHex("5151"))).toBeNull();
  });
});

describe("buildTreasuryScript", () => {
  it("is an ordinary P2PKH", () => {
    expect(buildTreasuryScript(H20).toHex()).toBe(
      `76a914${H20.map((b) => b.toString(16).padStart(2, "0")).join("")}88ac`
    );
  });

  it("refuses a hash that is not 20 bytes", () => {
    expect(() => buildTreasuryScript([1])).toThrow(/20 bytes/);
  });
});

describe("MINT_SIGHASH", () => {
  it("is SIGHASH_ALL | SIGHASH_FORKID, which is what sCrypt's ctx is taken over", () => {
    expect(MINT_SIGHASH).toBe(0x41);
  });
});
