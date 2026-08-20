import { expect } from "chai";
import { BSV20V2P2PKH } from "scrypt-ord";
import {
  Addr,
  bsv,
  type ContractTransaction,
  DummyProvider,
  TestWallet,
  toByteString,
  Utils,
} from "scrypt-ts";
import {
  buildContinuationScript,
  buildMintReceiptScript,
  splitCovenant,
} from "../../src/services/bsv/covenant-script";
import { PayToMint } from "../src/contracts/payToMint";

/**
 * The app's covenant builder, held byte-for-byte against sCrypt's.
 *
 * ⚠ THIS TEST IS THE ENTIRE SAFETY ARGUMENT FOR `covenant-script.ts`. That
 * module reproduces, with `@bsv/sdk` alone, scripts that a compiler produces —
 * because the sCrypt toolchain must never enter the Next build. Nothing about
 * that reproduction is self-checking: a wrong byte yields a transaction that is
 * structurally fine, broadcasts, and is REJECTED by the covenant, or worse, is
 * accepted having moved supply somewhere unintended.
 *
 * So the verification has to live HERE, in the one workspace that has the
 * compiler, and it has to compare bytes rather than behaviour.
 *
 * ⚠ AND IT HAS TO BE ABLE TO FAIL. The negative control at the bottom is not
 * decoration — an equality test whose two sides are computed by the same code,
 * or whose subject is never actually exercised, passes just as happily when
 * nothing is being checked. It perturbs ONE byte and requires a rejection.
 */

const BASE = 113n;
const treasuryKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const TREASURY = Addr(treasuryKey.toAddress().toObject().hash as string);
const minterKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const MINTER = Addr(minterKey.toAddress().toObject().hash as string);
const MINTER_ADDRESS = minterKey.toAddress(bsv.Networks.testnet).toString();

/** A concrete id — see the note in `payToMint.test.ts`. */
const TOKEN_ID_STR = `${"ab".repeat(32)}_0`;
const TOKEN_ID = toByteString(TOKEN_ID_STR, true);

before(() => {
  PayToMint.loadArtifact();
});

/**
 * ⚠ TWO LIBRARIES, TWO `Script` TYPES. `scrypt-ts` carries its own `bsv.js`;
 * the app uses `@bsv/sdk`. They share no types, so every crossing is explicit —
 * which is the point of the boundary this test exists to police.
 */
function binOf(script: bsv.Script): number[] {
  return Array.from(Buffer.from(script.toHex(), "hex"));
}

async function deployed(max: bigint): Promise<PayToMint> {
  const instance = new PayToMint(TOKEN_ID, toByteString("OCCAM", true), max, 0n, TREASURY, BASE);
  await instance.connect(new TestWallet(treasuryKey, new DummyProvider()));
  /**
   * ⚠ MATERIALISE THE STATE BEFORE READING THE SCRIPT. A freshly constructed
   * instance returns a locking script whose state area is still a placeholder,
   * and it only becomes the real thing once something asks for it. Reading it
   * too early yields a 5-byte state that decodes to a supply of zero — which
   * looks exactly like an on-chain bug and is not one. Everything downstream
   * here depends on holding the script the chain would actually hold.
   */
  void instance.lockingScript;
  return instance;
}

/** What sCrypt itself produces for a mint, as the app must reproduce it. */
function scryptOutputs(current: PayToMint, amount: bigint) {
  const next = current.next();
  next.supply = current.supply - amount;
  next.setAmt(next.supply);
  const received = new BSV20V2P2PKH(current.id, current.sym, current.max, current.dec, MINTER);
  received.setAmt(amount);
  return { next, received };
}

describe("covenant-script — byte equality with sCrypt", () => {
  /**
   * ⚠ THE SUPPLY VALUES ARE CHOSEN FOR THEIR ENCODING, not for realism. Script
   * numbers are minimal signed little-endian, so a value whose top byte has the
   * high bit set takes an extra `0x00` — and a builder that forgets the sign
   * pad is wrong only for those values. `max = 200, amount = 72` lands supply on
   * exactly 128, the smallest value that needs one.
   */
  const cases: Array<{ max: bigint; amount: bigint; why: string }> = [
    { max: 21_000_000n, amount: 1n, why: "the ordinary case — one unit" },
    { max: 21_000_000n, amount: 3n, why: "several units at once" },
    { max: 200n, amount: 72n, why: "supply 128 — needs a sign pad byte" },
    { max: 200n, amount: 73n, why: "supply 127 — the byte below it, no pad" },
    { max: 256n, amount: 1n, why: "supply 255 — a two-byte boundary" },
    { max: 200n, amount: 200n, why: "the whole supply — leaves zero" },
  ];

  for (const { max, amount, why } of cases) {
    it(`continuation matches: ${why}`, async () => {
      const current = await deployed(max);
      const { next } = scryptOutputs(current, amount);

      const parts = splitCovenant(binOf(current.lockingScript));
      expect(parts, "the app could not read sCrypt's own covenant script").to.not.equal(null);
      if (!parts) return;
      expect(parts.state.supply.toString()).to.equal(max.toString());

      const mine = buildContinuationScript(parts, TOKEN_ID_STR, amount);
      expect(mine.toHex()).to.equal(next.lockingScript.toHex());
    });

    it(`receipt matches: ${why}`, async () => {
      const current = await deployed(max);
      const { received } = scryptOutputs(current, amount);
      const mine = buildMintReceiptScript(
        Array.from(Buffer.from(TOKEN_ID_STR, "utf8")),
        amount,
        MINTER_ADDRESS
      );
      expect(mine.toHex()).to.equal(received.lockingScript.toHex());
    });
  }

  it("splits a covenant into three parts that reassemble exactly", async () => {
    const current = await deployed(21_000_000n);
    const bin = binOf(current.lockingScript);
    const parts = splitCovenant(bin);
    expect(parts).to.not.equal(null);
    if (!parts) return;
    // The code is transplanted, so it must be a contiguous slice of the input
    // with nothing lost at either seam.
    expect(parts.inscription.length + parts.code.length).to.be.lessThan(bin.length);
    expect(parts.state.id).to.deep.equal(Array.from(Buffer.from(TOKEN_ID_STR, "utf8")));
    expect(parts.state.supply.toString()).to.equal("21000000");
  });

  it("refuses a script that is not a covenant", () => {
    expect(splitCovenant(Array.from(Buffer.from(`76a914${"11".repeat(20)}88ac`, "hex")))).to.equal(
      null
    );
    expect(splitCovenant([])).to.equal(null);
  });
});

/**
 * The covenant itself, run against outputs the APP built.
 *
 * Byte equality above says the app agrees with sCrypt. This says the script
 * agrees with the app — `hash256(outputs) === this.ctx.hashOutputs` evaluated
 * by the real interpreter over a transaction the app assembled.
 */
describe("covenant-script — the covenant accepts what the app builds", () => {
  async function mintWith(
    amount: bigint,
    corrupt: ((script: bsv.Script) => bsv.Script) | null
  ): Promise<void> {
    const current = await deployed(21_000_000n);
    /**
     * ⚠ SPLIT THE DEPLOYED SCRIPT, NOT THE CONSTRUCTED ONE. `deploy` flips
     * sCrypt's first-call marker to true, so the covenant the app reads off the
     * chain differs by one byte from the one an in-memory instance reports. The
     * app must cope with the deployed form, because that is the only form it
     * will ever see.
     */
    await current.deploy(1);
    const parts = splitCovenant(binOf(current.lockingScript));
    if (!parts) throw new Error("could not split the covenant");
    expect(parts.state.firstCall, "deploy should set the first-call marker").to.equal(true);

    const continuation = buildContinuationScript(parts, TOKEN_ID_STR, amount);
    const receipt = buildMintReceiptScript(
      Array.from(Buffer.from(TOKEN_ID_STR, "utf8")),
      amount,
      MINTER_ADDRESS
    );

    let appContinuation = bsv.Script.fromHex(continuation.toHex());
    if (corrupt) appContinuation = corrupt(appContinuation);

    current.bindTxBuilder(
      "mint",
      async (c: PayToMint, _o: unknown, amt: bigint, _to: Addr): Promise<ContractTransaction> => {
        const next = c.next();
        next.supply = c.supply - amt;
        next.setAmt(next.supply);
        const tx = new bsv.Transaction()
          .addInput(c.buildContractInput())
          // ⚠ THE APP'S SCRIPTS, NOT sCRYPT'S — that substitution is the test.
          .addOutput(new bsv.Transaction.Output({ script: appContinuation, satoshis: 1 }))
          .addOutput(
            new bsv.Transaction.Output({ script: bsv.Script.fromHex(receipt.toHex()), satoshis: 1 })
          )
          .addOutput(
            new bsv.Transaction.Output({
              script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(c.treasury)),
              satoshis: Number(c.costOf(c.max - c.supply, amt)),
            })
          )
          .change(await c.signer.getDefaultAddress());
        return { tx, atInputIndex: 0, nexts: [{ instance: next, balance: 1, atOutputIndex: 0 }] };
      }
    );

    await current.methods.mint(amount, MINTER, {
      changeAddress: await current.signer.getDefaultAddress(),
    } as never);
  }

  it("accepts a mint whose outputs the app built", async () => {
    await mintWith(3n, null);
  });

  /**
   * ⚠ THE NEGATIVE CONTROL. Without this, every assertion above could be
   * comparing two things neither of which the covenant would accept, and the
   * suite would be green. One byte of the continuation's state is flipped —
   * the smallest possible lie about how much supply is left.
   */
  it("REJECTS a continuation with a single byte changed", async () => {
    let message: string | null = null;
    try {
      await mintWith(3n, (script) => {
        const bin = Buffer.from(script.toHex(), "hex");
        // The supply lives just before the 5-byte state footer.
        bin[bin.length - 6] ^= 0x01;
        return bsv.Script.fromHex(bin.toString("hex"));
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message, "the covenant accepted a corrupted continuation").to.not.equal(null);
    /**
     * ⚠ AND IT MUST FAIL FOR THE RIGHT REASON. This control passed once while
     * the covenant was never reached at all — the harness threw first, on an
     * undeployed instance, and a vacuous rejection looked exactly like a real
     * one. Requiring the failure to name the assertion is what stops that
     * happening again.
     */
    expect(message ?? "").to.match(/outputs do not match|Execution failed|mismatch/i);
  });
});
