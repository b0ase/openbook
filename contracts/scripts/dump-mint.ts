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
import { PayToMint } from "../src/contracts/payToMint";

/**
 * Dump the exact scripts a mint transaction carries — a DERIVATION, not a test.
 *
 * ⚠ WHAT THIS IS FOR. The app must be able to build a mint transaction WITHOUT
 * sCrypt: `scrypt-ts` pulls a compiler binary and a second Bitcoin library, and
 * `contracts/README.md` is explicit that it must never enter the Next build.
 * So the browser has to construct the same bytes with `@bsv/sdk` alone.
 *
 * The only safe way to write that is to look at what sCrypt actually produces
 * and reproduce it byte for byte — guessing at the unlocking script's shape
 * would be found out by broadcasting, which is the expensive way to learn.
 *
 * ⚠ AND THE RESULT IS A CONTRACT, NOT A ONE-OFF. Whatever the app builds must
 * be asserted byte-equal against this in a test that runs HERE, in the
 * workspace that has the compiler — so the boundary holds (no sCrypt in the
 * app) while the verification stays real.
 *
 *   npx ts-node scripts/dump-mint.ts     (or: node -r ts-node/register …)
 */

const BASE = 113n;
const MAX = 21_000_000n;
const TOKEN_ID = toByteString(`${"ab".repeat(32)}_0`, true);

const treasuryKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const TREASURY = Addr(treasuryKey.toAddress().toObject().hash as string);
const minterKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet);
const MINTER = Addr(minterKey.toAddress().toObject().hash as string);

function describeScript(label: string, script: bsv.Script) {
  const hex = script.toHex();
  console.log(`\n── ${label} ──`);
  console.log(`bytes  ${hex.length / 2}`);
  console.log(`asm    ${script.toASM().slice(0, 240)}${script.toASM().length > 240 ? " …" : ""}`);
  console.log(`chunks ${script.chunks.length}`);
  script.chunks.forEach((c, i) => {
    const size = c.buf ? c.buf.length : 0;
    const preview = c.buf ? c.buf.toString("hex").slice(0, 64) : `op_${c.opcodenum}`;
    console.log(`  [${i}] op=${c.opcodenum} len=${size} ${preview}${size > 32 ? "…" : ""}`);
  });
}

async function main() {
  PayToMint.loadArtifact();

  const instance = new PayToMint(TOKEN_ID, toByteString("OCCAM", true), MAX, 0n, TREASURY, BASE);
  await instance.connect(new TestWallet(treasuryKey, new DummyProvider()));
  await instance.deploy(1);

  describeScript("LOCKING SCRIPT (deployed covenant)", instance.lockingScript);

  const amount = 3n;

  const mintBuilder = async (
    current: PayToMint,
    _o: { changeAddress?: bsv.Address },
    amt: bigint,
    to: Addr
  ): Promise<ContractTransaction> => {
    const next = current.next();
    next.supply = current.supply - amt;
    next.setAmt(next.supply);

    const received = new BSV20V2P2PKH(current.id, current.sym, current.max, current.dec, to);
    received.setAmt(amt);

    const tx = new bsv.Transaction()
      .addInput(current.buildContractInput())
      .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
      .addOutput(new bsv.Transaction.Output({ script: received.lockingScript, satoshis: 1 }))
      .addOutput(
        new bsv.Transaction.Output({
          script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(current.treasury)),
          satoshis: Number(current.costOf(current.max - current.supply, amt)),
        })
      )
      .change(await current.signer.getDefaultAddress());

    return { tx, atInputIndex: 0, nexts: [{ instance: next, balance: 1, atOutputIndex: 0 }] };
  };
  instance.bindTxBuilder("mint", mintBuilder as Parameters<typeof instance.bindTxBuilder>[1]);

  const { tx } = await instance.methods.mint(amount, MINTER, {
    changeAddress: await instance.signer.getDefaultAddress(),
  } as never);

  describeScript("UNLOCKING SCRIPT (the mint spend)", tx.inputs[0].script);

  console.log("\n── TRANSACTION SHAPE ──");
  tx.outputs.forEach((o, i) => {
    console.log(`  out[${i}] sats=${o.satoshis} scriptBytes=${o.script.toHex().length / 2}`);
  });
  console.log(`\ncost for ${amount} from 0 minted: ${instance.costOf(0n, amount)} sats`);

  /**
   * ⚠ THE NUMBER THAT DECIDES WHETHER THIS IS AFFORDABLE. The covenant carries
   * its whole locking script in EVERY spend — once as the output it re-creates,
   * and once inside the sighash preimage — so a mint transaction is roughly
   * twice the contract's size no matter how few units are taken.
   */
  const txBytes = tx.toBuffer().length;
  const FEE_RATE = 110; // sats/kB, matching the app's SatoshisPerKilobyte(110)
  const fee = Math.ceil((txBytes / 1000) * FEE_RATE);
  console.log("");
  console.log(`tx size        ${txBytes.toLocaleString()} bytes`);
  console.log(`fee at ${FEE_RATE}/kB  ${fee.toLocaleString()} sats`);
  console.log(`mint price     ${instance.costOf(0n, 1n)} sats (first unit)`);
  console.log(`fee : price    ${(fee / Number(instance.costOf(0n, 1n))).toFixed(1)}x`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
