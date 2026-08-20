import { Utils } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import {
  buildCovenantScript,
  buildTransferInscription,
  type CovenantState,
  continuationState,
  decodeScriptNum,
  encodeCovenantState,
  encodeScriptNum,
  splitCovenant,
} from "./covenant-script";

/**
 * The covenant script builder, tested for the failures that cost money.
 *
 * ⚠ THE BYTE-EQUALITY PROOF IS NOT HERE. It cannot be: it needs the sCrypt
 * compiler, which must never enter this build. It lives in
 * `contracts/tests/covenantScript.test.ts` and runs with `npm test` in that
 * workspace. **Changing this file without re-running that one proves nothing** —
 * everything below is self-consistent by construction, and self-consistency is
 * exactly what a wrong byte layout also has.
 *
 * What this file covers is the half that does not need a compiler: the refusals,
 * the arithmetic, and the one place the app has to mirror on-chain behaviour
 * rather than copy bytes (`continuationState` and the genesis id).
 */

const ID = Utils.toArray(`${"ab".repeat(32)}_0`, "utf8");
const OUTPOINT = `${"cd".repeat(32)}_0`;

/** A covenant-shaped script with an opaque, made-up code section. */
function synthetic(state: CovenantState, code = [0x51, 0x52, 0x53]): number[] {
  return buildCovenantScript({
    inscription: buildTransferInscription(state.id, state.supply),
    // The trailing OP_RETURN belongs to the code half — see `splitCovenant`.
    code: [...code, 0x6a],
    state,
  }).toBinary();
}

describe("script numbers", () => {
  it("round-trips the values a supply actually takes", () => {
    for (const v of [0n, 1n, 2n, 127n, 128n, 255n, 256n, 21_000_000n, 2n ** 63n - 1n]) {
      expect(decodeScriptNum(encodeScriptNum(v)), `value ${v}`).toBe(v);
    }
  });

  /**
   * ⚠ THE CASE A NAIVE ENCODER GETS WRONG. 128 is `0x80`, whose high bit is the
   * sign bit — without a trailing pad byte the interpreter reads it as -0. A
   * supply off by a sign is a continuation whose hash does not match, and the
   * only symptom is a mint rejected at broadcast.
   */
  it("pads a value whose top byte would read as negative", () => {
    expect(encodeScriptNum(128n)).toEqual([0x80, 0x00]);
    expect(encodeScriptNum(127n)).toEqual([0x7f]);
    expect(encodeScriptNum(-128n)).toEqual([0x80, 0x80]);
  });

  it("encodes zero as nothing at all", () => {
    // Distinct from `writeInt(0)`, which is one `0x00` byte. The two are not
    // interchangeable and the state serializer depends on the difference.
    expect(encodeScriptNum(0n)).toEqual([]);
  });
});

describe("splitCovenant", () => {
  it("recovers the state it was built with", () => {
    const state: CovenantState = { firstCall: false, id: ID, supply: 20_999_997n };
    const parts = splitCovenant(synthetic(state));
    expect(parts).not.toBeNull();
    expect(parts?.state).toEqual(state);
  });

  it("keeps the first-call marker rather than assuming it", () => {
    const parts = splitCovenant(synthetic({ firstCall: true, id: ID, supply: 5n }));
    expect(parts?.state.firstCall).toBe(true);
  });

  it("separates the inscription from the code", () => {
    const parts = splitCovenant(synthetic({ firstCall: false, id: ID, supply: 9n }));
    expect(parts?.code).toEqual([0x51, 0x52, 0x53, 0x6a]);
    expect(Utils.toUTF8(parts?.inscription ?? [])).toContain('"op":"transfer"');
  });

  /**
   * ⚠ EVERY ONE OF THESE MUST RETURN NULL RATHER THAN A BEST GUESS. This parses
   * bytes fetched from the chain. A splitter that returns something plausible
   * for a script it has misread hands a fragment of somebody else's contract to
   * the transaction builder, which then spends a real UTXO against it.
   */
  it("refuses anything that is not shaped like a covenant", () => {
    expect(splitCovenant([])).toBeNull();
    expect(splitCovenant([0x76, 0xa9, 0x14])).toBeNull();

    const good = synthetic({ firstCall: false, id: ID, supply: 3n });

    // A version byte it does not recognise.
    const badVersion = [...good];
    badVersion[badVersion.length - 1] = 0x01;
    expect(splitCovenant(badVersion)).toBeNull();

    // A length field pointing outside the script.
    const badLen = [...good];
    badLen[badLen.length - 5] = 0xff;
    badLen[badLen.length - 4] = 0xff;
    expect(splitCovenant(badLen)).toBeNull();

    // A length field that lands somewhere other than an OP_RETURN — the check
    // that makes the length field trustworthy in the first place.
    const shifted = [...good];
    shifted[shifted.length - 5] = shifted[shifted.length - 5] - 1;
    expect(splitCovenant(shifted)).toBeNull();
  });

  it("refuses a state carrying more props than the covenant declares", () => {
    /**
     * A covenant declares exactly two state props. A script whose state holds a
     * third is not this contract — a different version, or a different contract
     * entirely — and building a continuation for it would transplant code we
     * have misread.
     */
    const body = [0x00, ID.length, ...ID, 0x01, 0x03, 0x01, 0x09];
    const script = [
      0x6a,
      ...body,
      body.length & 0xff,
      (body.length >> 8) & 0xff,
      (body.length >> 16) & 0xff,
      (body.length >> 24) & 0xff,
      0x00,
    ];
    expect(splitCovenant(script)).toBeNull();
  });
});

describe("encodeCovenantState", () => {
  it("writes the first-call marker as a bare byte, not a push", () => {
    // `VarIntWriter.writeBool` is the one field here without a push prefix.
    // A push would shift the whole state and change its declared length.
    const encoded = encodeCovenantState({ firstCall: true, id: [], supply: 0n });
    expect(encoded[0]).toBe(0x01);
    expect(encoded[1]).toBe(0x00); // writeBytes([]) — an empty push
  });

  it("declares its own length, excluding the footer", () => {
    const encoded = encodeCovenantState({ firstCall: false, id: ID, supply: 21_000_000n });
    const len = encoded[encoded.length - 5];
    expect(len).toBe(encoded.length - 5);
    expect(encoded[encoded.length - 1]).toBe(0x00);
  });
});

describe("continuationState", () => {
  it("subtracts what was minted", () => {
    const next = continuationState({ firstCall: false, id: ID, supply: 100n }, OUTPOINT, 3n);
    expect(next.supply).toBe(97n);
    expect(next.id).toEqual(ID);
  });

  it("always clears the first-call marker", () => {
    const next = continuationState({ firstCall: true, id: ID, supply: 100n }, OUTPOINT, 1n);
    expect(next.firstCall).toBe(false);
  });

  /**
   * ⚠ THE ONE PLACE THE APP MIRRORS THE CHAIN RATHER THAN COPYING IT. A BSV-21
   * token's id is its own deploy outpoint, so it cannot exist before the deploy
   * transaction does — the contract fills it in on first spend. Carrying the
   * empty id forward builds a continuation the covenant refuses, and it refuses
   * it only after the author has broadcast and paid.
   */
  it("takes the id from the outpoint when the input is genesis", () => {
    const next = continuationState({ firstCall: true, id: [], supply: 100n }, OUTPOINT, 1n);
    expect(Utils.toUTF8(next.id)).toBe(OUTPOINT);
  });

  it("refuses to mint nothing, or more than exists", () => {
    const state: CovenantState = { firstCall: false, id: ID, supply: 10n };
    expect(() => continuationState(state, OUTPOINT, 0n)).toThrow(/positive/);
    expect(() => continuationState(state, OUTPOINT, -1n)).toThrow(/positive/);
    expect(() => continuationState(state, OUTPOINT, 11n)).toThrow(/supply/);
    // The whole supply is legal — it leaves an empty covenant, not an error.
    expect(continuationState(state, OUTPOINT, 10n).supply).toBe(0n);
  });
});

describe("buildTransferInscription", () => {
  /**
   * ⚠ THE JSON IS A BYTE FORMAT, NOT AN OBJECT. The contract concatenates these
   * bytes literally, so key order and the absence of whitespace are part of the
   * protocol. `JSON.stringify` agrees today and would stop agreeing the moment
   * a field is added or a key reordered.
   */
  it("emits the exact bytes the contract concatenates", () => {
    const bin = buildTransferInscription(ID, 42n);
    const text = Utils.toUTF8(bin);
    expect(text).toContain(`{"p":"bsv-20","op":"transfer","id":"${"ab".repeat(32)}_0","amt":"42"}`);
    expect(text).toContain("application/bsv-20");
  });

  it("writes the amount as a decimal string, never scientific notation", () => {
    // A large supply through `Number` would render as `2.1e+7` and be indexed
    // as a different token amount, or as none.
    const text = Utils.toUTF8(buildTransferInscription(ID, 21_000_000n));
    expect(text).toContain('"amt":"21000000"');
  });
});
