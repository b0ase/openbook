/**
 * Assembling a complete mint transaction.
 *
 * `covenant-script.ts` builds the scripts a mint locks; `covenant-mint.ts`
 * builds the one it unlocks. This puts a whole transaction together, and its
 * entire job is to get four things in the right order and the change right.
 *
 * The shape is the contract's, not ours (`payToMint.ts`):
 *
 *     in  0     the covenant UTXO                      (no signature — see below)
 *     in  1..n  the funder's own coins                 (signed by the funder)
 *     out 0     the covenant again, with less supply
 *     out 1     the units, to the minter
 *     out 2     the price, to the treasury
 *     out 3     the funder's change — IF there is any
 *
 * ⚠ ZERO CHANGE MEANS THREE OUTPUTS, NOT A FOURTH WORTH NOTHING.
 * `buildChangeOutput` returns an empty ByteString when the change is zero, so
 * the covenant hashes three outputs and a transaction carrying a 0-satoshi
 * fourth fails `hash256(outputs)` — as would a 3-output transaction when change
 * is due. This is a real branch, not an edge case to wave at.
 *
 * ⚠ THE ORDER OF OPERATIONS IS FORCED AND THERE IS ONLY ONE THAT WORKS:
 * decide the change → build every output → take the preimage → write the
 * unlocking script → sign the funding inputs. The preimage commits to all the
 * outputs, and the change is *inside* it, so anything that adjusts the change
 * after the preimage is taken silently invalidates it.
 *
 * ⚠ WHICH IS WHY THE FEE IS ESTIMATED HIGH, ON PURPOSE. Normally a builder
 * calls `tx.fee()` and lets the change absorb the remainder — impossible here,
 * because the change is committed before signing and signature lengths vary
 * (DER is 71 or 72 bytes). So the size is over-estimated and the change set from
 * that. The leftover simply becomes fee. **Over-estimating costs a few
 * satoshis; under-estimating gets the transaction rejected for a low fee after
 * a 48KB broadcast**, so the asymmetry decides the direction.
 *
 * ⚠ THE COVENANT INPUT IS NOT SIGNED BY ANYONE. `mint` is permissionless — the
 * payment IS the authorisation. So this function can assemble a valid
 * transaction for a funder whose key it does not have, and the funder signs only
 * their own inputs. Serializing mints therefore never requires custody. See
 * DECISIONS "Minting is DECOUPLED from posting".
 */

import { P2PKH, type PrivateKey, type Script, Transaction, Utils } from "@bsv/sdk";
import { mintCostForRange } from "@/lib/mint-price";
import { addressHash, buildMintUnlockingScript, mintPreimage } from "./covenant-mint";
import { buildContinuationScript, buildMintReceiptScript, splitCovenant } from "./covenant-script";

/** Satoshis on a covenant output, and on each of the two ordinal outputs. */
const ORDINAL_SATS = 1;

/** Fee rate matching the rest of the app (`wallet.ts`, `post-economics.ts`). */
export const MINT_FEE_RATE_SATS_PER_KB = 110;

/**
 * Slack added to the size estimate, in bytes.
 *
 * Covers DER signature variance across the funding inputs and the fact that the
 * change amount's own push length depends on the change amount. Cheap
 * insurance: at 110 sat/kB this is well under a satoshi per byte.
 */
const SIZE_SLACK_BYTES = 64;

/** A P2PKH funding input the funder controls. */
export interface FundingUtxo {
  sourceTransaction: Transaction;
  vout: number;
  satoshis: number;
}

/** The covenant UTXO being spent. */
export interface CovenantUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** Its locking script, verbatim — the code is transplanted from it. */
  lockingScript: Script;
}

export interface MintPlan {
  covenant: CovenantUtxo;
  /** The BSV-21 token id: the DEPLOY outpoint, which is not the covenant's current one. */
  tokenId: string;
  amount: bigint;
  /** Total units ever issuable, as deployed. Needed to price the mint. */
  maxSupply: bigint;
  /** Satoshis for the first unit, as deployed. */
  basePrice: number;
  minterAddress: string;
  treasuryAddress: string;
  funding: FundingUtxo[];
  changeAddress: string;
  feeRatePerKb?: number;
}

export type BuildMintResult =
  | {
      status: "ok";
      tx: Transaction;
      txid: string;
      /** What the treasury is paid — recomputed here, never accepted from a caller. */
      priceSats: number;
      changeSats: number;
      /** What the miner actually gets, given the change we committed to. */
      feeSats: number;
    }
  | { status: "not_a_covenant" }
  | { status: "no_funding" }
  | { status: "insufficient_funds"; needed: number; available: number };

/** Estimated serialized size, deliberately on the high side. See the note above. */
function estimateSize(
  fundingCount: number,
  unlockingScriptBytes: number,
  outputScriptBytes: number[]
): number {
  const header = 8 + 5 + 5; // version + locktime + two var-int counts, generously
  const covenantInput = 32 + 4 + 5 + unlockingScriptBytes + 4;
  const fundingInputs = fundingCount * (32 + 4 + 1 + 107 + 4);
  const outputs = outputScriptBytes.reduce((n, len) => n + 8 + 5 + len, 0);
  return header + covenantInput + fundingInputs + outputs + SIZE_SLACK_BYTES;
}

/**
 * Build a mint transaction, signing only the funding inputs.
 *
 * `fundingKey` may be null: the transaction is assembled complete and left
 * unsigned, which is how a coordinator prepares a mint for somebody else to
 * sign. Every output is already fixed at that point — the covenant fixes three
 * of them and the fourth is the funder's own change — so a signer can verify
 * what they are agreeing to rather than trust whoever assembled it.
 */
export async function buildMintTransaction(
  plan: MintPlan,
  fundingKey: PrivateKey | null
): Promise<BuildMintResult> {
  const parts = splitCovenant(plan.covenant.lockingScript.toBinary());
  if (!parts) return { status: "not_a_covenant" };
  if (!plan.funding.length) return { status: "no_funding" };

  /**
   * ⚠ THE PRICE IS DERIVED FROM THE COVENANT'S OWN STATE, NEVER PASSED IN. The
   * contract computes `costOf(max - supply, amount)` and refuses anything that
   * pays less. A caller-supplied figure is a second place deriving one fact, and
   * the two would disagree exactly once — after broadcast.
   */
  const minted = plan.maxSupply - parts.state.supply;
  const priceSats = mintCostForRange(Number(minted), Number(plan.amount), plan.basePrice);

  const continuation = buildContinuationScript(parts, plan.tokenId, plan.amount);
  const tokenIdBytes = parts.state.id.length ? parts.state.id : Utils.toArray(plan.tokenId, "utf8");
  const receipt = buildMintReceiptScript(tokenIdBytes, plan.amount, plan.minterAddress);
  const treasury = new P2PKH().lock(plan.treasuryAddress);
  const changeLock = new P2PKH().lock(plan.changeAddress);

  const fundingTotal = plan.funding.reduce((n, u) => n + u.satoshis, 0);
  const available = fundingTotal + plan.covenant.satoshis;
  // Outputs 0 and 1 each carry one satoshi; output 2 carries the price.
  const fixedOut = ORDINAL_SATS * 2 + priceSats;

  // The unlocking script's size is dominated by the preimage, whose size is
  // dominated by the covenant script — all known before anything is built.
  const preimageBytes = plan.covenant.lockingScript.toBinary().length + 156;
  const unlockingBytes = preimageBytes + 60;
  const feeRate = plan.feeRatePerKb ?? MINT_FEE_RATE_SATS_PER_KB;
  const scriptLens = [
    continuation.toBinary().length,
    receipt.toBinary().length,
    treasury.toBinary().length,
    changeLock.toBinary().length,
  ];
  const size = estimateSize(plan.funding.length, unlockingBytes, scriptLens);
  const estimatedFee = Math.ceil((size * feeRate) / 1000);

  let changeSats = available - fixedOut - estimatedFee;
  if (changeSats < 0) {
    return { status: "insufficient_funds", needed: fixedOut + estimatedFee, available };
  }
  /**
   * ⚠ DUST CHANGE IS GIVEN TO THE MINER RATHER THAN CREATED. An output worth a
   * satoshi or two costs more to spend than it holds, and the covenant is
   * perfectly happy with no change output at all. Below the floor we drop to
   * three outputs — which is a different `hashOutputs`, hence the branch.
   */
  if (changeSats > 0 && changeSats < 10) changeSats = 0;

  const tx = new Transaction();

  /**
   * ⚠ `sourceTXID`, NOT `sourceTransaction`, FOR THE COVENANT. A covenant
   * transaction is ~48KB and fetching it would cost that on every mint — and it
   * is not needed: signing the funding inputs requires each input's OUTPOINT for
   * `hashPrevouts`, never the previous transaction's body. The one thing that
   * does need the covenant's script is the preimage, and we hold that already.
   */
  tx.addInput({
    sourceTXID: plan.covenant.txid,
    sourceOutputIndex: plan.covenant.vout,
    sequence: 0xffffffff,
  });

  for (const u of plan.funding) {
    tx.addInput({
      sourceTransaction: u.sourceTransaction,
      sourceOutputIndex: u.vout,
      unlockingScriptTemplate: fundingKey ? new P2PKH().unlock(fundingKey) : undefined,
      sequence: 0xffffffff,
    });
  }

  tx.addOutput({ lockingScript: continuation, satoshis: ORDINAL_SATS });
  tx.addOutput({ lockingScript: receipt, satoshis: ORDINAL_SATS });
  tx.addOutput({ lockingScript: treasury, satoshis: priceSats });
  if (changeSats > 0) tx.addOutput({ lockingScript: changeLock, satoshis: changeSats });

  // Everything is final — now, and only now, the preimage.
  const preimage = mintPreimage({
    sourceTXID: plan.covenant.txid,
    sourceOutputIndex: plan.covenant.vout,
    sourceSatoshis: plan.covenant.satoshis,
    subscript: plan.covenant.lockingScript,
    otherInputs: plan.funding.map((u) => ({
      sourceTXID: u.sourceTransaction.id("hex") as string,
      sourceOutputIndex: u.vout,
      sequence: 0xffffffff,
    })),
    inputIndex: 0,
    outputs: tx.outputs.map((o) => ({
      satoshis: o.satoshis ?? 0,
      lockingScript: o.lockingScript,
    })),
    transactionVersion: tx.version,
    lockTime: tx.lockTime,
    inputSequence: 0xffffffff,
  });

  tx.inputs[0].unlockingScript = buildMintUnlockingScript({
    amount: plan.amount,
    minterHash: addressHash(plan.minterAddress),
    preimage,
    changeSats: BigInt(changeSats),
    changeHash: addressHash(plan.changeAddress),
  });

  if (fundingKey) await tx.sign();

  const feeSats = available - fixedOut - changeSats;
  return {
    status: "ok",
    tx,
    txid: tx.id("hex") as string,
    priceSats,
    changeSats,
    feeSats,
  };
}
