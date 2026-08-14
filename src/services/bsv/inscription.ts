/**
 * 1Sat Ordinal inscriptions — the thing that turns a post into an ownable
 * on-chain object.
 *
 * ⚠ THIS IS THE DIFFERENCE THE WHOLE TOKEN MODEL RESTS ON. Everything the app
 * writes today is `OP_FALSE OP_RETURN <json>` (see `onchain.ts`): a permanent,
 * signed, timestamped RECORD on a **provably unspendable** output. Nobody can
 * own or transfer it, because there is nothing there to spend. An inscription
 * puts the same payload on a **1-satoshi output locked to an address**, so
 * ownership becomes "whoever can spend that satoshi" and transfer becomes an
 * ordinary transaction. See TOKENS.md, *We are ANCHORING posts, not inscribing
 * them*.
 *
 * ⚠ UNVERIFIED AGAINST A LIVE INDEXER. The envelope below follows the 1Sat
 * Ordinals convention — a standard P2PKH lock with the inscription appended:
 *
 *     OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
 *     OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <content> OP_ENDIF
 *
 * The envelope sits AFTER `OP_CHECKSIG`, so it never executes and cannot affect
 * spendability; it is data an indexer reads, not script the miner runs. The
 * tests below pin that structure, but a passing test proves we wrote what we
 * meant — NOT that GorillaPool or any other indexer will index it. **Broadcast
 * one inscription and confirm a public indexer shows it before turning paid
 * posting on for real users.**
 */

import { OP, P2PKH, Script, Utils } from "@bsv/sdk";

/** The satoshi that carries the inscription. One, by definition — it is what
 *  makes the output an ordinal rather than a payment. */
export const INSCRIPTION_SATS = 1;

/** Marker an indexer looks for inside the envelope. */
const ORD_MARKER = "ord";

export interface InscriptionInput {
  /** Address that will OWN the inscription — the post's author. */
  address: string;
  /** MIME type of the payload, e.g. `application/json`. */
  contentType: string;
  /** Payload bytes. */
  data: number[];
}

/**
 * Build the locking script for an inscription owned by `address`.
 *
 * Returns a script that is spendable exactly like an ordinary P2PKH — the
 * author can move their own post — with the inscription envelope appended as
 * unexecuted data.
 */
export function buildInscriptionScript({ address, contentType, data }: InscriptionInput): Script {
  if (!address) throw new Error("inscription requires an owner address");
  if (!contentType) throw new Error("inscription requires a content type");

  // The lock comes FIRST and is a plain P2PKH. Anything else would make the
  // output non-standard, and a post nobody can spend is not ownership.
  const lock = new P2PKH().lock(address);

  const script = new Script();
  for (const chunk of lock.chunks) script.chunks.push(chunk);

  script.writeOpCode(OP.OP_FALSE);
  script.writeOpCode(OP.OP_IF);
  script.writeBin(Utils.toArray(ORD_MARKER, "utf8"));
  script.writeOpCode(OP.OP_1);
  script.writeBin(Utils.toArray(contentType, "utf8"));
  script.writeOpCode(OP.OP_0);
  script.writeBin(data);
  script.writeOpCode(OP.OP_ENDIF);

  return script;
}

/**
 * Whether a script carries an inscription envelope.
 *
 * Deliberately structural rather than a hex substring match: `ord` appears in
 * plenty of arbitrary payloads, and a reader that keyed on the bytes alone
 * would call an ordinary post an inscription.
 */
export function hasInscription(script: Script): boolean {
  return findInscriptionStart(script) !== -1;
}

function findInscriptionStart(script: Script): number {
  const chunks = script.chunks;
  for (let i = 0; i + 1 < chunks.length; i++) {
    const isFalse = chunks[i].op === OP.OP_FALSE || chunks[i].op === OP.OP_0;
    if (!isFalse || chunks[i + 1].op !== OP.OP_IF) continue;
    const marker = chunks[i + 2]?.data;
    if (marker && Utils.toUTF8(marker) === ORD_MARKER) return i;
  }
  return -1;
}

export interface ParsedInscription {
  contentType: string;
  data: number[];
}

/**
 * Read an inscription back out of a locking script.
 *
 * Returns null rather than throwing on anything malformed — this parses
 * attacker-supplied bytes off the chain, where "shaped wrong" is an expected
 * input rather than an exceptional one.
 */
export function parseInscription(script: Script): ParsedInscription | null {
  const start = findInscriptionStart(script);
  if (start === -1) return null;

  const chunks = script.chunks;
  // start: OP_FALSE, +1: OP_IF, +2: "ord", +3: OP_1, +4: content-type,
  // +5: OP_0, +6: data, +7: OP_ENDIF
  const contentTypeChunk = chunks[start + 4]?.data;
  const dataChunk = chunks[start + 6]?.data;
  if (!contentTypeChunk) return null;
  if (chunks[start + 3]?.op !== OP.OP_1) return null;

  return {
    contentType: Utils.toUTF8(contentTypeChunk),
    // An empty payload is legal and distinct from a missing one.
    data: dataChunk ?? [],
  };
}
