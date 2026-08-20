/**
 * The mint spend: unlocking the pay-to-mint covenant with `@bsv/sdk` alone.
 *
 * `covenant-script.ts` builds the scripts a mint LOCKS. This builds the one it
 * UNLOCKS, which is where the covenant is actually satisfied — and it is five
 * pushes, all five computable:
 *
 *     <amount> <minterHash> <sighash preimage> <changeSats> <changeAddrHash>
 *
 * ⚠ THE ORDER IS THE COMPILER'S, NOT OURS. sCrypt lays a public method's
 * unlocking script out as: the declared arguments in order, then the sighash
 * preimage it injects for `this.ctx`, then the two `buildChangeOutput`
 * arguments it appends. `mint(amount, minter)` therefore produces exactly the
 * sequence above. Reordering any pair yields a script that still parses, still
 * broadcasts, and fails.
 *
 * ⚠ WHY THE PREIMAGE IS ORDINARY. It looked like the hard part and it is not:
 * the covenant's `this.ctx` is a standard BIP143 sighash preimage over
 * `SIGHASH_ALL | SIGHASH_FORKID` (0x41), which the SDK already produces. The
 * genuinely delicate work was the locking scripts, and it is done and verified.
 *
 * ⚠ THE COVENANT INPUT NEEDS NO SIGNATURE, and that is the property everything
 * downstream rests on. `mint` is permissionless — the payment IS the
 * authorisation. So the only signatures in a mint transaction belong to whoever
 * funded it, over their own inputs. A coordinator can therefore assemble a
 * complete mint transaction it cannot spend, hand it to the funder to sign
 * their inputs, and broadcast the result — WITHOUT ever holding the funder's
 * key. Custody is not required to serialize minting. See DECISIONS "Minting is
 * decoupled from posting".
 */

import { OP, Script, TransactionSignature, Utils } from "@bsv/sdk";
import { encodeScriptNum } from "./covenant-script";

/** `SIGHASH_ALL | SIGHASH_FORKID` — what sCrypt's `this.ctx` is taken over. */
export const MINT_SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;

/**
 * Push a script number the way the interpreter expects to find it.
 *
 * ⚠ SMALL VALUES ARE OPCODES, NOT PUSHES. 1..16 are `OP_1`..`OP_16` and zero is
 * `OP_0`; pushing them as one-byte data instead is a different script that
 * leaves the same value on the stack — so it evaluates identically here and
 * differs byte-for-byte from what sCrypt emits. That matters because the
 * unlocking script's bytes are compared against sCrypt's in
 * `contracts/tests/`, and because a mint amount of 3 is the common case.
 */
export function pushScriptNum(script: Script, value: bigint): Script {
  if (value === 0n) return script.writeOpCode(OP.OP_0);
  if (value >= 1n && value <= 16n) {
    return script.writeOpCode(OP.OP_1 + Number(value) - 1);
  }
  if (value === -1n) return script.writeOpCode(OP.OP_1NEGATE);
  return script.writeBin(encodeScriptNum(value));
}

export interface MintUnlocking {
  /** Units being taken. */
  amount: bigint;
  /** 20-byte pubkey hash of whoever receives them. */
  minterHash: number[];
  /** BIP143 preimage of the spending transaction. */
  preimage: number[];
  /**
   * The funder's change, in satoshis.
   *
   * ⚠ THIS IS COMMITTED TWICE AND BOTH MUST AGREE. It is pushed here AND it is
   * inside the preimage's `hashOutputs`, because the covenant rebuilds the
   * change output from this value and hashes it with the rest. A change output
   * that does not match this number fails `hash256(outputs)`.
   */
  changeSats: bigint;
  /** 20-byte pubkey hash the change returns to. */
  changeHash: number[];
}

/** The five pushes, in the order the compiler laid them out. */
export function buildMintUnlockingScript(u: MintUnlocking): Script {
  if (u.minterHash.length !== 20) throw new Error("minter hash must be 20 bytes");
  if (u.changeHash.length !== 20) throw new Error("change hash must be 20 bytes");
  if (!u.preimage.length) throw new Error("preimage is required");
  if (u.amount <= 0n) throw new Error("mint amount must be positive");
  if (u.changeSats < 0n) throw new Error("change cannot be negative");

  const script = new Script();
  pushScriptNum(script, u.amount);
  script.writeBin(u.minterHash);
  script.writeBin(u.preimage);
  pushScriptNum(script, u.changeSats);
  script.writeBin(u.changeHash);
  return script;
}

export interface MintPreimageInput {
  /** Outpoint of the covenant UTXO being spent. */
  sourceTXID: string;
  sourceOutputIndex: number;
  /** Satoshis on it — one, for a covenant. */
  sourceSatoshis: number;
  /** The covenant's own locking script, verbatim. */
  subscript: Script;
  /** Every OTHER input of the spending transaction, in order. */
  otherInputs: Array<{ sourceTXID: string; sourceOutputIndex: number; sequence?: number }>;
  /** Index of the covenant input. Zero — the contract asserts it. */
  inputIndex: number;
  /** Every output of the spending transaction, in order. */
  outputs: Array<{ satoshis: number; lockingScript: Script }>;
  transactionVersion: number;
  lockTime: number;
  inputSequence: number;
}

/**
 * The preimage the covenant checks itself against.
 *
 * ⚠ IT COMMITS TO THE WHOLE TRANSACTION, SO NOTHING MAY CHANGE AFTER THIS. Add
 * an input, adjust the change by one satoshi, or reorder an output, and the
 * preimage is stale — the covenant computes a different `hashOutputs` and
 * refuses. Build the transaction completely, then take the preimage, then
 * assemble the unlocking script. In that order, always.
 */
export function mintPreimage(input: MintPreimageInput): number[] {
  return TransactionSignature.format({
    sourceTXID: input.sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: input.sourceSatoshis,
    transactionVersion: input.transactionVersion,
    otherInputs: input.otherInputs.map((i) => ({
      sourceTXID: i.sourceTXID,
      sourceOutputIndex: i.sourceOutputIndex,
      sequence: i.sequence ?? 0xffffffff,
    })) as Parameters<typeof TransactionSignature.format>[0]["otherInputs"],
    outputs: input.outputs as Parameters<typeof TransactionSignature.format>[0]["outputs"],
    inputIndex: input.inputIndex,
    subscript: input.subscript,
    inputSequence: input.inputSequence,
    lockTime: input.lockTime,
    scope: MINT_SIGHASH,
  });
}

/** The treasury payment output's script — an ordinary P2PKH to a 20-byte hash. */
export function buildTreasuryScript(treasuryHash: number[]): Script {
  if (treasuryHash.length !== 20) throw new Error("treasury hash must be 20 bytes");
  const script = new Script();
  script.writeOpCode(OP.OP_DUP);
  script.writeOpCode(OP.OP_HASH160);
  script.writeBin(treasuryHash);
  script.writeOpCode(OP.OP_EQUALVERIFY);
  script.writeOpCode(OP.OP_CHECKSIG);
  return script;
}

/** Read the five pushes back out — used by the tests, and by anything auditing a mint. */
export function parseMintUnlockingScript(script: Script): MintUnlocking | null {
  const c = script.chunks;
  if (c.length !== 5) return null;
  const num = (i: number): bigint | null => {
    const op = c[i].op;
    if (op === OP.OP_0) return 0n;
    if (op >= OP.OP_1 && op <= OP.OP_16) return BigInt(op - OP.OP_1 + 1);
    return c[i].data ? decode(c[i].data as number[]) : null;
  };
  const decode = (b: number[]): bigint => {
    if (!b.length) return 0n;
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--) {
      const byte = i === b.length - 1 ? b[i] & 0x7f : b[i];
      n = (n << 8n) | BigInt(byte);
    }
    return (b[b.length - 1] & 0x80) !== 0 ? -n : n;
  };
  const amount = num(0);
  const changeSats = num(3);
  if (amount === null || changeSats === null) return null;
  if (!c[1].data || !c[2].data || !c[4].data) return null;
  return {
    amount,
    minterHash: c[1].data,
    preimage: c[2].data,
    changeSats,
    changeHash: c[4].data,
  };
}

/** Convenience: the 20-byte hash inside a P2PKH address. */
export function addressHash(address: string): number[] {
  return Utils.fromBase58Check(address).data as number[];
}
