/**
 * The pay-to-mint covenant's locking script, built with `@bsv/sdk` alone.
 *
 * ⚠ WHY THIS FILE EXISTS. `contracts/README.md` is explicit that the sCrypt
 * toolchain must never enter the Next build — it pulls a compiler binary and a
 * second Bitcoin library. But minting is a per-post operation, so the app has
 * to produce the covenant's bytes without it.
 *
 * ⚠ THE CODE IS COPIED FROM THE CHAIN, NEVER TEMPLATED — this is the decision
 * the whole module rests on, and it is what makes the approach safe rather than
 * merely possible.
 *
 * The obvious way to do this is to ship the compiled artifact's 23,685-byte
 * `hex`, substitute the six constructor parameters, and hope the substitution
 * matches what the compiler would have emitted. That reimplements a compiler's
 * output format from observation, and every mistake is discovered by
 * broadcasting.
 *
 * It is also unnecessary, because of a fact that can be checked rather than
 * trusted: **a mint's continuation carries the SAME contract code as the input
 * it spends.** Verified byte-for-byte against sCrypt's own output — the only
 * parts that differ between the covenant before a mint and after it are the
 * leading BSV-21 inscription (whose `amt` changes) and the trailing state
 * (whose `supply` changes). Everything between them is identical.
 *
 * So the app reads the covenant UTXO it is about to spend — which it must fetch
 * anyway, to build the sighash preimage — splits it into three, and rebuilds
 * only the two small ends. The 24KB middle is transplanted verbatim. It cannot
 * drift from what is on chain, because it *is* what is on chain, and no
 * compiler artifact ships to the browser.
 *
 * ── THE LAYOUT (derived from sCrypt's output, not guessed) ──────────────────
 *
 *     <BSV-21 inscription envelope>   ‖  <contract code>  ‖  OP_RETURN <state>
 *
 * and the state, from `VarIntWriter.serializeState` in `scrypt-ts`:
 *
 *     <bool firstCall> <bytes id> <int supply>  <uint32LE len>  <0x00 version>
 *
 * ⚠ THE FIVE TRAILING BYTES ARE HOW THE STATE IS FOUND, and scanning for the
 * last `OP_RETURN` is NOT an acceptable substitute. `0x6a` is an ordinary byte
 * and appears inside 24KB of compiled script by coincidence; a scan finds the
 * real boundary today and a different one after any recompile. The length field
 * gives an exact answer, and the `OP_RETURN` it lands on is then *checked* —
 * a verification that can fail, rather than a search that always returns
 * something.
 */

import { OP, P2PKH, Script, Utils } from "@bsv/sdk";

/** Bytes of the trailing state-length field. `VarIntReader.StateLen`. */
const STATE_LEN_BYTES = 4;
/** Bytes of the trailing state-version field. `VarIntReader.VersionLen`. */
const VERSION_LEN_BYTES = 1;
/** The only state version sCrypt emits. `VarIntReader.Version`. */
const STATE_VERSION = 0;

/** Content type every BSV-21 inscription declares. */
const BSV20_CONTENT_TYPE = "application/bsv-20";
/** Marker an ordinals indexer looks for inside the envelope. */
const ORD_MARKER = "ord";

/** The covenant's decoded state — the only part of it that ever changes. */
export interface CovenantState {
  /**
   * sCrypt's own first-call marker. True on the deployed genesis output, false
   * on every continuation. Carried through rather than interpreted: it is the
   * compiler's bookkeeping, and the app's job is to reproduce it, not to have
   * an opinion about it.
   */
  firstCall: boolean;
  /**
   * The token id, as its ASCII bytes (`<txid>_<vout>`).
   *
   * ⚠ EMPTY ON A GENESIS OUTPUT, AND THAT IS NOT A MISSING VALUE. A BSV-21
   * token's id is its own deploy outpoint, which cannot be known before the
   * deploy transaction exists — so the contract assigns it to itself on first
   * spend (`initId`). A continuation must therefore carry the REAL id even
   * though the output it spends carries none. See `continuationState`.
   */
  id: number[];
  /** Units not yet issued, held by this UTXO. */
  supply: bigint;
}

/** A covenant locking script, taken apart. */
export interface CovenantParts {
  /** The leading BSV-21 envelope. Empty for a script that carries none. */
  inscription: number[];
  /**
   * The contract itself — opaque, and deliberately so. Nothing here reads it,
   * parses it or validates it beyond its boundaries; it is transplanted.
   */
  code: number[];
  state: CovenantState;
}

/**
 * Minimal signed little-endian script number — sCrypt's `int2ByteString`.
 *
 * ⚠ THE SIGN BYTE IS NOT OPTIONAL. A value whose top byte has the high bit set
 * takes an extra `0x00`, or the script engine reads it as negative. Getting
 * this wrong produces a supply that is wrong by roughly 2^n and a continuation
 * whose hash does not match, so it fails at broadcast rather than silently.
 */
export function encodeScriptNum(value: bigint): number[] {
  if (value === 0n) return [];
  const negative = value < 0n;
  let n = negative ? -value : value;
  const out: number[] = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if (out[out.length - 1] & 0x80) out.push(negative ? 0x80 : 0x00);
  else if (negative) out[out.length - 1] |= 0x80;
  return out;
}

/** Read one back. Inverse of `encodeScriptNum`. */
export function decodeScriptNum(bytes: readonly number[]): bigint {
  if (!bytes.length) return 0n;
  const last = bytes[bytes.length - 1];
  const negative = (last & 0x80) !== 0;
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const b = i === bytes.length - 1 ? last & 0x7f : bytes[i];
    n = (n << 8n) | BigInt(b);
  }
  return negative ? -n : n;
}

/** `VarIntWriter.writeBytes` — a push prefix, then the bytes. */
function writeBytesField(buf: readonly number[]): number[] {
  const n = buf.length;
  if (n < 0x4c) return [n, ...buf];
  if (n < 0x100) return [0x4c, n, ...buf];
  if (n < 0x10000) return [0x4d, n & 0xff, (n >> 8) & 0xff, ...buf];
  return [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...buf];
}

/** Read one push field back, returning its payload and where it ended. */
function readBytesField(
  bin: readonly number[],
  at: number
): { data: number[]; next: number } | null {
  if (at >= bin.length) return null;
  const op = bin[at];
  let len: number;
  let start: number;
  if (op < 0x4c) {
    len = op;
    start = at + 1;
  } else if (op === 0x4c) {
    if (at + 1 >= bin.length) return null;
    len = bin[at + 1];
    start = at + 2;
  } else if (op === 0x4d) {
    if (at + 2 >= bin.length) return null;
    len = bin[at + 1] | (bin[at + 2] << 8);
    start = at + 3;
  } else if (op === 0x4e) {
    if (at + 4 >= bin.length) return null;
    len = bin[at + 1] | (bin[at + 2] << 8) | (bin[at + 3] << 16) | (bin[at + 4] << 24);
    start = at + 5;
  } else {
    return null;
  }
  if (start + len > bin.length) return null;
  return { data: bin.slice(start, start + len), next: start + len };
}

/** `VarIntWriter.writeInt` — note that ZERO is one `0x00` byte, not nothing. */
function writeIntField(value: bigint): number[] {
  return writeBytesField(value === 0n ? [0x00] : encodeScriptNum(value));
}

/**
 * Serialize a covenant's state exactly as `getStateScript` would.
 *
 * ⚠ `firstCall` IS A RAW BYTE, NOT A PUSH. `VarIntWriter.writeBool` emits a
 * bare `0x01`/`0x00`, unlike every other field here. Wrapping it in a push
 * prefix shifts the whole state by one byte and changes its length, which fails
 * the covenant's `hash256(outputs)` check.
 */
export function encodeCovenantState(state: CovenantState): number[] {
  const body = [
    state.firstCall ? 0x01 : 0x00,
    ...writeBytesField(state.id),
    ...writeIntField(state.supply),
  ];
  const len = body.length;
  return [
    ...body,
    len & 0xff,
    (len >> 8) & 0xff,
    (len >> 16) & 0xff,
    (len >> 24) & 0xff,
    STATE_VERSION,
  ];
}

/** Decode a state body (the bytes between `OP_RETURN` and the length field). */
function decodeCovenantState(body: readonly number[]): CovenantState | null {
  if (!body.length) return null;
  const firstCallByte = body[0];
  if (firstCallByte !== 0x00 && firstCallByte !== 0x01) return null;
  const idField = readBytesField(body, 1);
  if (!idField) return null;
  const supplyField = readBytesField(body, idField.next);
  if (!supplyField) return null;
  // Anything after the two declared props means this is not the script we think
  // it is — a different contract, or a different compiler. Refuse rather than
  // build a continuation for something we have misread.
  if (supplyField.next !== body.length) return null;
  return {
    firstCall: firstCallByte === 0x01,
    id: idField.data,
    supply: decodeScriptNum(supplyField.data),
  };
}

/**
 * Where the leading BSV-21 envelope ends, or 0 if there is none.
 *
 * Structural, matching `inscription.ts`: a hex search for `ord` would match
 * arbitrary payload bytes, and a deploy output's own JSON contains plenty.
 */
function inscriptionEnd(bin: readonly number[]): number {
  if (bin.length < 4) return 0;
  if (bin[0] !== OP.OP_0 && bin[0] !== OP.OP_FALSE) return 0;
  if (bin[1] !== OP.OP_IF) return 0;
  const marker = readBytesField(bin, 2);
  if (!marker || Utils.toUTF8(marker.data) !== ORD_MARKER) return 0;
  if (bin[marker.next] !== OP.OP_1) return 0;
  const contentType = readBytesField(bin, marker.next + 1);
  if (!contentType) return 0;
  let at = contentType.next;
  if (bin[at] !== OP.OP_0 && bin[at] !== OP.OP_FALSE) return 0;
  const data = readBytesField(bin, at + 1);
  if (!data) return 0;
  at = data.next;
  if (bin[at] !== OP.OP_ENDIF) return 0;
  return at + 1;
}

/**
 * Take a covenant locking script apart.
 *
 * Returns null for anything that is not shaped like one — this parses bytes
 * read off the chain, where "wrong shape" is an expected input rather than an
 * exceptional one, and where guessing would mean building a transaction
 * against a script we have misunderstood.
 */
export function splitCovenant(bin: readonly number[]): CovenantParts | null {
  const suffix = STATE_LEN_BYTES + VERSION_LEN_BYTES;
  if (bin.length < suffix + 2) return null;

  if (bin[bin.length - 1] !== STATE_VERSION) return null;
  const lenAt = bin.length - suffix;
  const stateLen =
    bin[lenAt] | (bin[lenAt + 1] << 8) | (bin[lenAt + 2] << 16) | (bin[lenAt + 3] << 24);
  if (stateLen <= 0 || stateLen > lenAt - 1) return null;

  const bodyStart = lenAt - stateLen;
  // ⚠ THE CHECK THAT MAKES THE LENGTH FIELD TRUSTWORTHY. Without it a script
  // whose last five bytes happen to look like a state footer would be split at
  // an arbitrary offset, and the "code" transplanted into the continuation
  // would be a fragment.
  if (bin[bodyStart - 1] !== OP.OP_RETURN) return null;

  const state = decodeCovenantState(bin.slice(bodyStart, lenAt));
  if (!state) return null;

  const insEnd = inscriptionEnd(bin);
  return {
    inscription: bin.slice(0, insEnd),
    // Includes the OP_RETURN: it belongs to the code half of the script, and
    // keeping it there means reassembly is a plain concatenation.
    code: bin.slice(insEnd, bodyStart),
    state,
  };
}

/**
 * The BSV-21 transfer inscription — `createTransferInsciption` in `scrypt-ord`.
 *
 * ⚠ BUILT BY CONCATENATION, NOT `JSON.stringify`. The contract composes these
 * bytes literally, so key order and the absence of whitespace are part of the
 * format rather than a formatting preference. `JSON.stringify` happens to agree
 * today for this object, and would stop agreeing the moment a field is added.
 */
export function buildTransferInscription(tokenId: readonly number[], amt: bigint): number[] {
  const json =
    '{"p":"bsv-20","op":"transfer","id":"' +
    Utils.toUTF8([...tokenId]) +
    '","amt":"' +
    amt.toString() +
    '"}';
  const script = new Script();
  script.writeOpCode(OP.OP_0);
  script.writeOpCode(OP.OP_IF);
  script.writeBin(Utils.toArray(ORD_MARKER, "utf8"));
  script.writeOpCode(OP.OP_1);
  script.writeBin(Utils.toArray(BSV20_CONTENT_TYPE, "utf8"));
  script.writeOpCode(OP.OP_0);
  script.writeBin(Utils.toArray(json, "utf8"));
  script.writeOpCode(OP.OP_ENDIF);
  return script.toBinary();
}

/**
 * The state a continuation must carry, given the covenant being spent.
 *
 * ⚠ THE ID COMES FROM THE OUTPOINT WHEN THE INPUT IS GENESIS, and this is the
 * one place the app has to mirror on-chain behaviour rather than copy bytes.
 * `initId()` fills the id in during execution, so the deployed output's state
 * carries an empty one while the continuation the contract hashes carries the
 * real one. Copying the empty id forward produces a continuation the covenant
 * refuses — and refuses only at broadcast.
 */
export function continuationState(
  current: CovenantState,
  deployOutpoint: string,
  amount: bigint
): CovenantState {
  if (amount <= 0n) throw new Error("mint amount must be positive");
  if (amount > current.supply) throw new Error("not enough supply left");
  const id = current.id.length ? current.id : Utils.toArray(deployOutpoint, "utf8");
  return { firstCall: false, id, supply: current.supply - amount };
}

/** Reassemble a covenant script from its three parts. */
export function buildCovenantScript(parts: {
  inscription: readonly number[];
  code: readonly number[];
  state: CovenantState;
}): Script {
  return Script.fromBinary([
    ...parts.inscription,
    ...parts.code,
    ...encodeCovenantState(parts.state),
  ]);
}

/**
 * Output 0 of a mint: the covenant, carrying one mint less supply.
 *
 * The code is the input's own, transplanted. See the note at the top of this
 * file for why that is the whole point.
 */
export function buildContinuationScript(
  current: CovenantParts,
  deployOutpoint: string,
  amount: bigint
): Script {
  const state = continuationState(current.state, deployOutpoint, amount);
  return buildCovenantScript({
    inscription: buildTransferInscription(state.id, state.supply),
    code: current.code,
    state,
  });
}

/**
 * Output 1 of a mint: the units themselves, as an ordinary BSV-21 transfer to
 * the minter. `BSV20V2.buildTransferScript`.
 */
export function buildMintReceiptScript(
  tokenId: readonly number[],
  amount: bigint,
  minterAddress: string
): Script {
  const lock = new P2PKH().lock(minterAddress);
  return Script.fromBinary([...buildTransferInscription(tokenId, amount), ...lock.toBinary()]);
}

/** Exported for the byte-equality tests in `contracts/`. */
export const __covenantInternals = {
  writeBytesField,
  readBytesField,
  writeIntField,
  inscriptionEnd,
};
