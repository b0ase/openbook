/**
 * The human/AI exchange record.
 *
 * These are about what the record can and cannot prove. Every test that matters
 * is an attempt to alter a published transcript without the chain noticing.
 */

import { describe, expect, it } from "vitest";
import {
  ATTEST_TS_WINDOW_MS,
  appendTurn,
  formatTranscript,
  hashTurn,
  isAttestableTs,
  stampTurn,
  verifyChain,
} from "./agent-record";

/** A fixed epoch, so a hash assertion never depends on when the suite ran. */
const T0 = Date.UTC(2026, 7, 15, 2, 14, 3);

function chainOf(...turns: ["human" | "agent", string][]) {
  const chain: ReturnType<typeof appendTurn>[] = [];
  turns.forEach(([role, text], i) => {
    chain.push(appendTurn(chain, role, text, T0 + i * 1000));
  });
  return chain;
}

describe("hashTurn", () => {
  it("is deterministic", () => {
    expect(hashTurn(null, "human", "hello", T0)).toBe(hashTurn(null, "human", "hello", T0));
    expect(hashTurn(null, "human", "hello", T0)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("puts the ROLE inside the hash", () => {
    // Otherwise a question and an answer with identical text hash the same, and
    // the two could be swapped without breaking the chain — re-attributing
    // machine output to the human, or the reverse.
    expect(hashTurn(null, "human", "same words", T0)).not.toBe(
      hashTurn(null, "agent", "same words", T0)
    );
  });

  it("puts the TIME inside the hash", () => {
    // ⚠ Without this a transcript could be re-dated freely while every hash
    // still verified — and when a person and a machine spoke is the field most
    // worth lying about in a record of who said what.
    expect(hashTurn(null, "agent", "same words", T0)).not.toBe(
      hashTurn(null, "agent", "same words", T0 + 1)
    );
  });

  it("cannot be confused by text containing the field separator", () => {
    // ⚠ Length-prefixed, not joined on a delimiter. With plain concatenation
    // these two turns would digest identically, so a crafted question could
    // impersonate a different exchange.
    const a = hashTurn("aa", "human", "b|c", T0);
    const b = hashTurn("aa|human|b", "human", "c", T0);
    expect(a).not.toBe(b);
    expect(hashTurn(null, "human", "4:xxxx", T0)).not.toBe(hashTurn(null, "human", "xxxx", T0));
  });

  it("cannot be confused by text that mimics the trailing timestamp field", () => {
    // The time is appended last, so a text ending in something timestamp-shaped
    // is the natural place for a collision if the fields were not measured.
    expect(hashTurn(null, "agent", `done${T0}`, T0)).not.toBe(hashTurn(null, "agent", "done", T0));
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

  it("catches a RE-DATED turn", () => {
    // The point of hashing the time: moving an answer to a different moment
    // must break the record rather than quietly rewrite when it happened.
    const chain = chainOf(["human", "q1"], ["agent", "a1"]);
    chain[1] = { ...chain[1], ts: chain[1].ts + 86_400_000 };
    expect(verifyChain(chain)).toEqual({ ok: false, index: 1, reason: "bad_hash" });
  });

  it("catches turns whose times run BACKWARDS", () => {
    // ⚠ Each hash commits to its own time, so a chain assembled out of order can
    // still hash correctly end to end. Comparing the times to each other is the
    // only thing that notices a conversation that answers before it is asked.
    const a = appendTurn([], "human", "q", T0 + 60_000);
    const b = appendTurn([a], "agent", "a", T0);
    expect(verifyChain([a, b])).toEqual({ ok: false, index: 1, reason: "time_travel" });
  });

  it("allows two turns within the same millisecond", () => {
    const a = appendTurn([], "human", "q", T0);
    const b = appendTurn([a], "agent", "a", T0);
    expect(verifyChain([a, b])).toEqual({ ok: true });
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
    const forged = appendTurn([chain[0]], "agent", "fabricated", T0 + 500);
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

describe("isAttestableTs", () => {
  it("signs only times near the attesting server's own clock", () => {
    // ⚠ The client supplies the timestamp so the hash can stay stable while the
    // answer streams. Signing it unchecked would let anyone mint an ATTESTED
    // record dated to any moment they chose.
    const now = T0;
    expect(isAttestableTs(now, now)).toBe(true);
    expect(isAttestableTs(now - ATTEST_TS_WINDOW_MS, now)).toBe(true);
    expect(isAttestableTs(now + ATTEST_TS_WINDOW_MS, now)).toBe(true);
  });

  it("refuses a backdated or post-dated turn", () => {
    const now = T0;
    expect(isAttestableTs(now - ATTEST_TS_WINDOW_MS - 1, now)).toBe(false);
    expect(isAttestableTs(now + ATTEST_TS_WINDOW_MS + 1, now)).toBe(false);
    expect(isAttestableTs(Date.UTC(1999, 0, 1), now)).toBe(false);
  });

  it("refuses anything that is not a finite number", () => {
    for (const bad of [undefined, null, "1786753734425", Number.NaN, Infinity, {}]) {
      expect(isAttestableTs(bad, T0)).toBe(false);
    }
  });

  it("leaves room for slow answers and mildly skewed clocks", () => {
    // A legitimate exchange must not lose its signature over a few minutes of
    // drift — an unattested turn is a real loss of evidence, not a tidy default.
    expect(isAttestableTs(T0 - 4 * 60_000, T0)).toBe(true);
  });
});

describe("stampTurn", () => {
  it("is UTC, to the second, with no locale in it", () => {
    // Read by strangers in other timezones years later: one moment, one string.
    expect(stampTurn(T0)).toBe("2026-08-15T02:14:03Z");
  });
});

describe("formatTranscript", () => {
  it("labels who said what, and WHEN", () => {
    // The published string IS the record — the post carries no other per-turn
    // structure, so a time left out here is one no reader can ever recover.
    const chain = chainOf(["human", "why?"], ["agent", "because."]);
    expect(formatTranscript(chain)).toBe(
      "Q [2026-08-15T02:14:03Z]: why?\n\nA [2026-08-15T02:14:04Z]: because."
    );
  });

  it("is empty for an empty chain", () => {
    expect(formatTranscript([])).toBe("");
  });
});
