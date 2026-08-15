/**
 * A tamper-evident record of a human/AI exchange.
 *
 * The board's claim is that the record of who wrote what is public and
 * permanent. An AI-assisted post breaks that unless you can also see WHAT WAS
 * ASKED and WHAT THE MACHINE RETURNED — otherwise machine output and human
 * authorship are indistinguishable once published.
 *
 * ⚠ HASHING ALONE PROVES NOTHING ABOUT THE AI. A hash the poster computes over
 * text the poster supplies is a hash of whatever they felt like claiming — they
 * can invent an answer, hash it, and the chain is internally consistent. It
 * makes the record TAMPER-EVIDENT AFTER PUBLICATION, which is worth having, but
 * it is not evidence the agent ever said it.
 *
 * What supplies that is `attestation`: a signature by the SERVER THAT RAN THE
 * MODEL over the turn hash. The server is the only party that knows what the
 * model actually returned, so its signature is the only thing that can speak to
 * it. Without an attestation a turn is a CLAIM; with one it is attested. Both
 * are representable here on purpose, and readers must be able to tell them
 * apart — see `AgentTurn.attestation`.
 */

import { Hash, Utils } from "@bsv/sdk";

export type TurnRole = "human" | "agent";

export interface AgentTurn {
  role: TurnRole;
  text: string;
  /** sha256 over `prevHash|role|text`, hex. */
  hash: string;
  /** The previous turn's hash, or null for the first turn. */
  prevHash: string | null;
  /**
   * Signature by the server that produced this turn, over `hash`.
   *
   * Present only on `agent` turns, and only when the operator configured an
   * attestation key. **Absent means UNATTESTED — the turn is what the poster
   * says the agent replied, not what the server witnessed.** Never render an
   * unattested agent turn as though it were verified.
   */
  attestation?: { signature: string; pubkey: string };
}

/**
 * Hash one turn into the chain.
 *
 * ⚠ THE ROLE IS INSIDE THE HASH. Without it, a question and an answer with the
 * same text hash identically, and the two could be swapped without breaking the
 * chain — which would let a record be re-attributed from the machine to the
 * human or back.
 *
 * ⚠ THE FIELDS ARE LENGTH-PREFIXED, not concatenated with a separator. Joining
 * on `|` lets a crafted text containing `|` shift the boundary and produce the
 * same digest as a different turn.
 */
export function hashTurn(prevHash: string | null, role: TurnRole, text: string): string {
  const parts = [prevHash ?? "", role, text];
  const payload = parts.map((p) => `${Utils.toArray(p, "utf8").length}:${p}`).join("");
  return Utils.toHex(Hash.sha256(Utils.toArray(payload, "utf8")));
}

/** Append a turn to a chain, returning the new turn. */
export function appendTurn(chain: AgentTurn[], role: TurnRole, text: string): AgentTurn {
  const prevHash = chain.length ? chain[chain.length - 1].hash : null;
  return { role, text, prevHash, hash: hashTurn(prevHash, role, text) };
}

export type ChainVerdict =
  | { ok: true }
  | { ok: false; index: number; reason: "bad_hash" | "broken_link" };

/**
 * Recompute a chain and report the FIRST turn that does not match.
 *
 * Returns the index rather than a bare boolean so a reader can show exactly
 * where a transcript stops being trustworthy, instead of discarding the whole
 * conversation because one turn was edited.
 */
export function verifyChain(chain: AgentTurn[]): ChainVerdict {
  for (let i = 0; i < chain.length; i++) {
    const turn = chain[i];
    const expectedPrev = i === 0 ? null : chain[i - 1].hash;
    if (turn.prevHash !== expectedPrev) return { ok: false, index: i, reason: "broken_link" };
    if (turn.hash !== hashTurn(turn.prevHash, turn.role, turn.text)) {
      return { ok: false, index: i, reason: "bad_hash" };
    }
  }
  return { ok: true };
}

/** Render a chain for publication — the exact text that goes on-chain. */
export function formatTranscript(chain: AgentTurn[]): string {
  return chain
    .map((t) => `${t.role === "human" ? "Q" : "A"}: ${t.text}`)
    .join("\n\n")
    .trim();
}
