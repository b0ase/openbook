import { P2PKH, PrivateKey, Script as SdkScript, Transaction as SdkTx } from "@bsv/sdk";
import { expect } from "chai";
import { Addr, bsv, DummyProvider, TestWallet, toByteString } from "scrypt-ts";
import { buildMintTransaction } from "../../src/services/bsv/covenant-mint-tx";
import { PayToMint } from "../src/contracts/payToMint";

/**
 * A mint transaction the APP assembled, run through a real script interpreter.
 *
 * ⚠ THIS IS THE STRONGEST TEST IN THE REPO FOR THIS PATH, and it is stronger
 * than the byte-equality suites beside it. Those prove the app agrees with
 * sCrypt about individual scripts. This proves the covenant — the actual
 * compiled Bitcoin script that will hold real supply — ACCEPTS a whole
 * transaction that no part of sCrypt helped build: our outputs, in our order,
 * with our change arithmetic, our preimage and our unlocking script.
 *
 * If this passes, the only things left between here and a live mint are network
 * facts: fee floors, relay policy, and whether an indexer notices.
 */

const BASE = 113n;
const MAX = 21_000_000n;
const TOKEN_ID_STR = `${"ab".repeat(32)}_0`;

const treasuryKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const TREASURY_ADDR = treasuryKey.toAddress(bsv.Networks.testnet).toString();
const TREASURY = Addr(treasuryKey.toAddress().toObject().hash as string);

/** The funder — a key the covenant knows nothing about. */
const funderKey = PrivateKey.fromRandom();
const FUNDER_ADDR = funderKey.toPublicKey().toAddress();
const minterKey = PrivateKey.fromRandom();
const MINTER_ADDR = minterKey.toPublicKey().toAddress();

/**
 * ⚠ POST-GENESIS LIMITS, OR NOTHING HERE MEANS ANYTHING. bsv.js defaults to the
 * legacy 520-byte stack-element cap, and the covenant's preimage is ~24KB — so
 * an unconfigured interpreter rejects EVERY mint with `SCRIPT_ERR_PUSH_SIZE`,
 * including the ones that should fail, which makes each control test pass for
 * the wrong reason. BSV lifted the cap at Genesis and scryptlib raises it the
 * same way (`scryptlib/dist/contract.js`).
 */
const IFLAGS = bsv.Script.Interpreter as unknown as Record<string, number> & {
  MAX_SCRIPT_ELEMENT_SIZE: number;
  MAXIMUM_ELEMENT_SIZE: number;
};
IFLAGS.MAX_SCRIPT_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;
IFLAGS.MAXIMUM_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;

/** The flags scryptlib itself verifies with, so this cannot drift from sCrypt. */
const FLAGS =
  IFLAGS.SCRIPT_ENABLE_MAGNETIC_OPCODES |
  IFLAGS.SCRIPT_ENABLE_MONOLITH_OPCODES |
  IFLAGS.SCRIPT_VERIFY_STRICTENC |
  IFLAGS.SCRIPT_ENABLE_SIGHASH_FORKID |
  IFLAGS.SCRIPT_VERIFY_LOW_S |
  IFLAGS.SCRIPT_VERIFY_NULLFAIL |
  IFLAGS.SCRIPT_VERIFY_DERSIG;

before(() => {
  PayToMint.loadArtifact();
});

/** A deployed covenant, and where it sits. */
async function deployedCovenant(): Promise<{ script: SdkScript; txid: string; vout: number }> {
  const instance = new PayToMint(
    toByteString(TOKEN_ID_STR, true),
    toByteString("OCCAM", true),
    MAX,
    0n,
    TREASURY,
    BASE
  );
  await instance.connect(new TestWallet(treasuryKey, new DummyProvider()));
  void instance.lockingScript;
  await instance.deploy(1);
  const utxo = instance.utxo;
  if (!utxo) throw new Error("the covenant did not deploy");
  return {
    script: SdkScript.fromHex(instance.lockingScript.toHex()),
    txid: utxo.txId,
    vout: utxo.outputIndex,
  };
}

/** A coin for the funder to spend. */
function fundingSource(satoshis: number): SdkTx {
  const tx = new SdkTx();
  tx.addOutput({ lockingScript: new P2PKH().lock(FUNDER_ADDR), satoshis });
  return tx;
}

/** Run the real interpreter over our transaction against the real covenant. */
function verifyAgainstCovenant(
  txHex: string,
  covenantScriptHex: string,
  covenantSats: number
): { ok: boolean; err: string } {
  const tx = new bsv.Transaction(txHex);
  const interpreter = new bsv.Script.Interpreter();
  const ok = interpreter.verify(
    tx.inputs[0].script,
    bsv.Script.fromHex(covenantScriptHex),
    tx,
    0,
    FLAGS,
    new bsv.crypto.BN(covenantSats)
  );
  return { ok, err: interpreter.errstr ?? "" };
}

async function mint(amount: bigint, funding: number) {
  const covenant = await deployedCovenant();
  const source = fundingSource(funding);
  const result = await buildMintTransaction(
    {
      covenant: {
        txid: covenant.txid,
        vout: covenant.vout,
        satoshis: 1,
        lockingScript: covenant.script,
      },
      tokenId: TOKEN_ID_STR,
      amount,
      maxSupply: MAX,
      basePrice: Number(BASE),
      minterAddress: MINTER_ADDR,
      treasuryAddress: TREASURY_ADDR,
      funding: [{ sourceTransaction: source, vout: 0, satoshis: funding }],
      changeAddress: FUNDER_ADDR,
    },
    funderKey
  );
  return { result, covenant };
}

describe("covenant-mint-tx — the covenant accepts a transaction the app assembled", () => {
  // ⚠ FUNDING SCALES WITH THE CURVE. 100 units cost 113 x 5050 = 570,650 sats,
  // so a flat funding figure silently turns a covenant test into an
  // insufficient-funds test.
  for (const { amount, funding } of [
    { amount: 1n, funding: 200_000 },
    { amount: 3n, funding: 200_000 },
    { amount: 100n, funding: 1_000_000 },
  ]) {
    it(`accepts a mint of ${amount} units`, async () => {
      const { result, covenant } = await mint(amount, funding);
      expect(result.status).to.equal("ok");
      if (result.status !== "ok") return;

      // Four outputs, in the contract's order, with the price the curve says.
      expect(result.tx.outputs).to.have.length(4);
      expect(result.priceSats).to.equal(Number(BASE) * Number((amount * (amount + 1n)) / 2n));
      expect(result.tx.outputs[2].satoshis).to.equal(result.priceSats);

      const { ok, err } = verifyAgainstCovenant(result.tx.toHex(), covenant.script.toHex(), 1);
      expect(ok, `interpreter rejected the mint: ${err}`).to.equal(true);
    });
  }

  /**
   * ⚠ THE BRANCH THAT IS EASY TO GET WRONG. `buildChangeOutput` emits NOTHING
   * when the change is zero, so a transaction with a 0-satoshi fourth output
   * hashes differently and is refused. Funding the mint with almost exactly what
   * it costs drives the builder down that path.
   */
  it("accepts a mint with NO change output at all", async () => {
    const covenant = await deployedCovenant();
    // Price for one unit is BASE; fund just enough that the leftover is dust.
    const probe = await mint(1n, 200_000);
    if (probe.result.status !== "ok") throw new Error("probe failed");
    const exact = 200_000 - probe.result.changeSats + 5;

    const source = fundingSource(exact);
    const result = await buildMintTransaction(
      {
        covenant: {
          txid: covenant.txid,
          vout: covenant.vout,
          satoshis: 1,
          lockingScript: covenant.script,
        },
        tokenId: TOKEN_ID_STR,
        amount: 1n,
        maxSupply: MAX,
        basePrice: Number(BASE),
        minterAddress: MINTER_ADDR,
        treasuryAddress: TREASURY_ADDR,
        funding: [{ sourceTransaction: source, vout: 0, satoshis: exact }],
        changeAddress: FUNDER_ADDR,
      },
      funderKey
    );
    expect(result.status).to.equal("ok");
    if (result.status !== "ok") return;
    expect(result.changeSats).to.equal(0);
    expect(result.tx.outputs).to.have.length(3);

    const { ok, err } = verifyAgainstCovenant(result.tx.toHex(), covenant.script.toHex(), 1);
    expect(ok, `interpreter rejected the no-change mint: ${err}`).to.equal(true);
  });

  /**
   * ⚠ THE CONTROL. Everything above could pass with an interpreter that accepts
   * anything. Underpaying the treasury by ONE satoshi is the smallest possible
   * lie, and the covenant exists to refuse exactly it.
   */
  it("REJECTS a mint that pays the treasury one satoshi less", async () => {
    const { result, covenant } = await mint(3n, 200_000);
    if (result.status !== "ok") throw new Error("build failed");
    const tampered = new bsv.Transaction(result.tx.toHex());
    tampered.outputs[2] = new bsv.Transaction.Output({
      script: tampered.outputs[2].script,
      satoshis: tampered.outputs[2].satoshis - 1,
    });
    const { ok, err } = verifyAgainstCovenant(tampered.toString(), covenant.script.toHex(), 1);
    expect(ok, "the covenant accepted an underpayment").to.equal(false);
    /**
     * ⚠ AND FOR THE RIGHT REASON. This control passed once already while the
     * interpreter was rejecting every transaction on the legacy 520-byte push
     * limit — so it refused the tampered mint and the honest one alike, and
     * looked green either way. Requiring the failure to come from the script's
     * own verification is what makes it mean anything.
     */
    expect(err).to.not.match(/PUSH_SIZE/);
  });

  it("refuses to build when the funding cannot cover the mint", async () => {
    const { result } = await mint(1n, 50);
    expect(result.status).to.equal("insufficient_funds");
  });

  it("refuses a locking script that is not a covenant", async () => {
    const result = await buildMintTransaction(
      {
        covenant: {
          txid: "ab".repeat(32),
          vout: 0,
          satoshis: 1,
          lockingScript: new P2PKH().lock(FUNDER_ADDR),
        },
        tokenId: TOKEN_ID_STR,
        amount: 1n,
        maxSupply: MAX,
        basePrice: Number(BASE),
        minterAddress: MINTER_ADDR,
        treasuryAddress: TREASURY_ADDR,
        funding: [{ sourceTransaction: fundingSource(10_000), vout: 0, satoshis: 10_000 }],
        changeAddress: FUNDER_ADDR,
      },
      funderKey
    );
    expect(result.status).to.equal("not_a_covenant");
  });
});
