import { Script as SdkScript } from "@bsv/sdk";
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
  buildMintUnlockingScript,
  mintPreimage,
  parseMintUnlockingScript,
} from "../../src/services/bsv/covenant-mint";
import { PayToMint } from "../src/contracts/payToMint";

/**
 * The mint SPEND, held byte-for-byte against sCrypt's.
 *
 * ⚠ WHAT WOULD GO WRONG WITHOUT THIS. The unlocking script is five pushes whose
 * ORDER is a compiler's layout convention, and the preimage commits to the whole
 * transaction. Both are things you can get plausibly wrong and only discover by
 * broadcasting a mint that the covenant refuses — after the funder has paid the
 * network fee for a 48KB transaction.
 *
 * The method here is to let sCrypt build a real mint, then rebuild its
 * unlocking script from its own five values and require the bytes to match, and
 * to recompute its preimage over its own transaction and require that to match
 * too. Those are the two things the app must produce.
 */

const BASE = 113n;
const MAX = 21_000_000n;
const TOKEN_ID = toByteString(`${"ab".repeat(32)}_0`, true);

const treasuryKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const TREASURY = Addr(treasuryKey.toAddress().toObject().hash as string);
const minterKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const MINTER = Addr(minterKey.toAddress().toObject().hash as string);

before(() => {
  PayToMint.loadArtifact();
});

/** A real mint, built and validated by sCrypt itself. */
async function scryptMint(amount: bigint): Promise<bsv.Transaction> {
  const instance = new PayToMint(TOKEN_ID, toByteString("OCCAM", true), MAX, 0n, TREASURY, BASE);
  await instance.connect(new TestWallet(treasuryKey, new DummyProvider()));
  void instance.lockingScript;
  await instance.deploy(1);

  instance.bindTxBuilder(
    "mint",
    async (c: PayToMint, _o: unknown, amt: bigint, to: Addr): Promise<ContractTransaction> => {
      const next = c.next();
      next.supply = c.supply - amt;
      next.setAmt(next.supply);
      const received = new BSV20V2P2PKH(c.id, c.sym, c.max, c.dec, to);
      received.setAmt(amt);
      const tx = new bsv.Transaction()
        .addInput(c.buildContractInput())
        .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
        .addOutput(new bsv.Transaction.Output({ script: received.lockingScript, satoshis: 1 }))
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

  const { tx } = await instance.methods.mint(amount, MINTER, {
    changeAddress: await instance.signer.getDefaultAddress(),
  } as never);
  return tx;
}

/** The covenant's own locking script, as the spend sees it. */
/**
 * ⚠ `version` and `nLockTime` EXIST AT RUNTIME BUT NOT IN bsv.js's TYPES. Read
 * off the transaction rather than assumed to be 1 and 0 — a preimage built from
 * assumed values matches only while the assumption happens to hold.
 */
function versionOf(tx: bsv.Transaction): number {
  return (tx as unknown as { version: number }).version;
}

function subscriptOf(tx: bsv.Transaction): SdkScript {
  const out = tx.inputs[0].output;
  if (!out) throw new Error("the contract input carries no source output");
  return SdkScript.fromHex(out.script.toHex());
}

describe("covenant-mint — the unlocking script", () => {
  for (const amount of [1n, 3n, 17n, 1000n]) {
    /**
     * ⚠ THE AMOUNTS STRADDLE THE OPCODE BOUNDARY. 1..16 are pushed as
     * `OP_1`..`OP_16`, anything above as data. A builder that pushes everything
     * as data leaves the same value on the stack — the script evaluates
     * identically — and differs byte-for-byte from what sCrypt emits. 17 is the
     * first value on the far side.
     */
    it(`rebuilds sCrypt's own bytes for amount ${amount}`, async () => {
      const tx = await scryptMint(amount);
      const theirs = SdkScript.fromHex(tx.inputs[0].script.toHex());

      const parsed = parseMintUnlockingScript(theirs);
      expect(parsed, "the app could not read sCrypt's unlocking script").to.not.equal(null);
      if (!parsed) return;
      expect(parsed.amount.toString()).to.equal(amount.toString());

      const mine = buildMintUnlockingScript(parsed);
      expect(mine.toHex()).to.equal(theirs.toHex());
    });
  }
});

describe("covenant-mint — the sighash preimage", () => {
  it("recomputes the preimage sCrypt embedded, over sCrypt's own transaction", async () => {
    const tx = await scryptMint(3n);
    const theirs = SdkScript.fromHex(tx.inputs[0].script.toHex());
    const parsed = parseMintUnlockingScript(theirs);
    if (!parsed) throw new Error("could not parse the unlocking script");

    const covenantInput = tx.inputs[0];
    const mine = mintPreimage({
      sourceTXID: covenantInput.prevTxId.toString("hex"),
      sourceOutputIndex: covenantInput.outputIndex,
      sourceSatoshis: covenantInput.output?.satoshis ?? 1,
      subscript: subscriptOf(tx),
      otherInputs: tx.inputs.slice(1).map((i) => ({
        sourceTXID: i.prevTxId.toString("hex"),
        sourceOutputIndex: i.outputIndex,
        sequence: i.sequenceNumber,
      })),
      inputIndex: 0,
      outputs: tx.outputs.map((o) => ({
        satoshis: o.satoshis,
        lockingScript: SdkScript.fromHex(o.script.toHex()),
      })),
      transactionVersion: versionOf(tx),
      lockTime: tx.nLockTime,
      inputSequence: covenantInput.sequenceNumber,
    });

    expect(Buffer.from(mine).toString("hex")).to.equal(
      Buffer.from(parsed.preimage).toString("hex")
    );
  });

  /**
   * ⚠ THE CONTROL. The preimage commits to every output, so a change of one
   * satoshi anywhere must produce different bytes. Without this the equality
   * above could be comparing two constants that ignore the transaction.
   */
  it("changes when the transaction does", async () => {
    const tx = await scryptMint(3n);
    const base = {
      sourceTXID: tx.inputs[0].prevTxId.toString("hex"),
      sourceOutputIndex: tx.inputs[0].outputIndex,
      sourceSatoshis: tx.inputs[0].output?.satoshis ?? 1,
      subscript: subscriptOf(tx),
      otherInputs: [],
      inputIndex: 0,
      transactionVersion: versionOf(tx),
      lockTime: tx.nLockTime,
      inputSequence: tx.inputs[0].sequenceNumber,
    };
    const outputs = tx.outputs.map((o) => ({
      satoshis: o.satoshis,
      lockingScript: SdkScript.fromHex(o.script.toHex()),
    }));
    const before = mintPreimage({ ...base, outputs });
    const nudged = outputs.map((o, i) => (i === 2 ? { ...o, satoshis: o.satoshis - 1 } : o));
    const after = mintPreimage({ ...base, outputs: nudged });
    expect(Buffer.from(before).toString("hex")).to.not.equal(Buffer.from(after).toString("hex"));
  });
});
