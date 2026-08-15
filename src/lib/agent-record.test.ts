/**
 * The human/AI exchange record.
 *
 * These are about what the record can and cannot prove. Every test that matters
 * is an attempt to alter a published transcript without the chain noticing.
 */

import { describe, expect, it } from "vitest";
import { appendTurn, formatTranscript, hashTurn, verifyChain } from "./agent-record";

function chainOf(...turns: ["human" | "agent", string][]) {
  const chain: ReturnType<typeof appendTurn>[] = [];
  for (const [role, text] of turns) chain.push(appendTurn(chain, role, text));
  return chain;
}

describe("hashTurn", () => {
  it("is deterministic", () => {
    expect(hashTurn(null, "human", "hello")).toBe(hashTurn(null, "human", "hello"));
    expect(hashTurn(null, "human", "hello")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("puts the ROLE inside the hash", () => {
    // Otherwise a question and an answer with identical text hash the same, and
    // the two could be swapped without breaking the chain — re-attributing
    // machine output to the human, or the reverse.
    expect(hashTurn(null, "human", "same words")).not.toBe(hashTurn(null, "agent", "same words"));
  });

  it("cannot be confused by text containing the field separator", () => {
    // ⚠ Length-prefixed, not joined on a delimiter. With plain concatenation
    // these two turns would digest identically, so a crafted question could
    // impersonate a different exchange.
    const a = hashTurn("aa", "human", "b|c");
    const b = hashTurn("aa", "human", "b").slice(0, 0) + hashTurn("aa|human|b", "human", "c");
    expect(a).not.toBe(b);
    expect(hashTurn(null, "human", "4:xxxx")).not.toBe(hashTurn(null, "human", "xxxx"));
  });
});

describe("chains", () => {
  it("links each turn to the one before it", () => {
    const chain = chainOf(["human", "what is this?"], ["agent", "a board."]);
    expect(chain[0].prevHash).toBeNull();
    expect(chain[1].prevHash).toBe(chain[0].hash);
    expect(verifyChain(chain)).toEqual({ ok: true });
  });

  it("catches an EDITED turn and says which one", () => {
    const chain = chainOf(["human", "q1"], ["agent", "a1"], ["human", "q2"]);
    chain[1] = { ...chain[1], text: "something the agent never said" };

    // Reported by index so a reader can see where the transcript stops being
    // trustworthy, rather than discarding the whole conversation.
    expect(verifyChain(chain)).toEqual({ ok: false, index: 1, reason: "bad_hash" });
  });

  it("catches a REORDERED or removed turn", () => {
    const chain = chainOf(["human", "q1"], ["agent", "a1"], ["human", "q2"]);
    const missingMiddle = [chain[0], chain[2]];
    expect(verifyChain(missingMiddle)).toEqual({ ok: false, index: 1, reason: "broken_link" });

    const swapped = [chain[1], chain[0]];
    expect(verifyChain(swapped).ok).toBe(false);
  });

  it("catches a turn INSERTED into the middle", () => {
    const chain = chainOf(["human", "q1"], ["agent", "a1"]);
    const forged = appendTurn([chain[0]], "agent", "fabricated");
    expect(verifyChain([chain[0], forged, chain[1]]).ok).toBe(false);
  });

  it("accepts an empty chain and a single turn", () => {
    expect(verifyChain([])).toEqual({ ok: true });
    expect(verifyChain(chainOf(["human", "solo"]))).toEqual({ ok: true });
  });

  it("⚠ does NOT prove the agent said anything — only that nothing changed after", () => {
    // A poster can invent an answer and chain it perfectly. The chain is
    // tamper-evidence AFTER publication; only a server attestation speaks to
    // what the model actually returned. This test exists so nobody reads
    // `verifyChain(...).ok === true` as "the AI said this".
    const fabricated = chainOf(["human", "did you say X?"], ["agent", "yes, I said X"]);
    expect(verifyChain(fabricated)).toEqual({ ok: true });
    expect(fabricated[1].attestation).toBeUndefined();
  });
});

describe("formatTranscript", () => {
  it("labels who said what", () => {
    const chain = chainOf(["human", "why?"], ["agent", "because."]);
    expect(formatTranscript(chain)).toBe("Q: why?\n\nA: because.");
  });

  it("is empty for an empty chain", () => {
    expect(formatTranscript([])).toBe("");
  });
});
