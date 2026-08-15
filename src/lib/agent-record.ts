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
  /**
   * When the turn happened, ms since epoch.
   *
   * ⚠ WHOSE CLOCK THIS IS DEPENDS ON THE ROLE, and the difference is the same
   * one that separates a claim from a record. A `human` turn's time is the
   * poster's own clock — their statement about themselves, unverifiable and
   * fine. An `agent` turn's time originates from the server that ran the model
   * (`X-Agent-Ts`) and is covered by `attestation`, so an attested turn carries
   * a time somebody other than the poster stands behind.
   *
   * It is INSIDE the hash: a record of a human/AI exchange that can be
   * re-dated after the fact is not much of a record.
   */
  ts: number;
  /** sha256 over `prevHash|role|text|ts`, hex. */
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
 *
 * ⚠ THE TIME IS INSIDE THE HASH. Left out, a transcript could be re-dated freely
 * while every hash still verified — and for a record whose point is *when* a
 * person and a machine said something to each other, that is the field most
 * worth lying about.
 */
export function hashTurn(
  prevHash: string | null,
  role: TurnRole,
  text: string,
  ts: number
): string {
  const parts = [prevHash ?? "", role, text, String(ts)];
  const payload = parts.map((p) => `${Utils.toArray(p, "utf8").length}:${p}`).join("");
  return Utils.toHex(Hash.sha256(Utils.toArray(payload, "utf8")));
}

/** Append a turn to a chain, returning the new turn. */
export function appendTurn(
  chain: AgentTurn[],
  role: TurnRole,
  text: string,
  ts: number
): AgentTurn {
  const prevHash = chain.length ? chain[chain.length - 1].hash : null;
  return { role, text, ts, prevHash, hash: hashTurn(prevHash, role, text, ts) };
}

export type ChainVerdict =
  | { ok: true }
  | { ok: false; index: number; reason: "bad_hash" | "broken_link" | "time_travel" };

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
    if (turn.hash !== hashTurn(turn.prevHash, turn.role, turn.text, turn.ts)) {
      return { ok: false, index: i, reason: "bad_hash" };
    }
    // ⚠ A conversation cannot run backwards. Each turn's hash commits to its own
    // time, so the hashes stay valid across a re-ordered chain — only comparing
    // the times to each other catches turns assembled out of sequence.
    if (i > 0 && turn.ts < chain[i - 1].ts) {
      return { ok: false, index: i, reason: "time_travel" };
    }
  }
  return { ok: true };
}

/**
 * How far a turn's claimed time may sit from the attesting server's clock.
 *
 * Wide enough that a slow answer, a retry, or a browser a few minutes out of
 * sync still gets attested — a legitimate exchange must not lose its signature
 * over clock skew.
 */
export const ATTEST_TS_WINDOW_MS = 10 * 60_000;

/**
 * Whether a server should put its name to a turn carrying this timestamp.
 *
 * ⚠ THE CLIENT SUPPLIES THE TIME, so the server must not sign it blindly. The
 * time has to come from the client because the hash is computed as the answer
 * streams and must not change underneath the reader — but a signature over an
 * arbitrary client timestamp would let anyone mint an attested record dated to
 * any moment they liked, backwards or forwards. Signing only near-now leaves
 * the hash stable and the date meaningful.
 */
export function isAttestableTs(ts: unknown, now: number): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(now - ts) <= ATTEST_TS_WINDOW_MS;
}

/** A turn's time as it is written into the published record. */
export function stampTurn(ts: number): string {
  // Seconds, UTC, no local formatting: the record is read by strangers in other
  // timezones years later, and `2026-08-15T02:14:03Z` still means one moment.
  return `${new Date(ts).toISOString().slice(0, 19)}Z`;
}

/**
 * Render a chain for publication — the exact text that goes on-chain.
 *
 * The stamps ride in the text because this string IS the record once it is
 * published: the post carries no other per-turn structure, so a time omitted
 * here is a time nobody reading the chain can recover.
 */
export function formatTranscript(chain: AgentTurn[]): string {
  return chain
    .map((t) => `${t.role === "human" ? "Q" : "A"} [${stampTurn(t.ts)}]: ${t.text}`)
    .join("\n\n")
    .trim();
}
