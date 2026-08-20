/**
 * Screening a draft BEFORE the author's browser spends anything.
 *
 * ⚠ WHAT THIS IS GUARDING. The screen inside `createPost` runs AFTER
 * `payForPost` has already broadcast the inscription — so by the time it
 * refuses, the content is on chain permanently and the author has paid for it.
 * `screenDraft` is the call that happens first, and for an ENCRYPTED room post
 * it is the only screen there will ever be, because the server cannot read
 * ciphertext.
 *
 * So the failures that matter are the ones where it says `ok` when it should
 * not: a denied draft waved through, or a throttled call answered
 * optimistically — either one and the client broadcasts on the strength of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(
    new Map([
      ["x-forwarded-for", "10.0.0.77"],
      ["x-real-ip", "10.0.0.77"],
    ])
  ),
}));

import { screenDraft } from "./actions";

const DENY = "/\\bforbidden-example-phrase\\b/";

describe("screenDraft", () => {
  beforeEach(() => {
    process.env.CONTENT_DENYLIST = DENY;
  });

  it("passes ordinary content", async () => {
    expect(await screenDraft("an ordinary thought about $Occam")).toEqual({ ok: true });
  });

  it("REFUSES denylisted content before anything is spent", async () => {
    expect(await screenDraft("this contains a forbidden-example-phrase inside")).toEqual({
      ok: false,
    });
  });

  it("treats an empty draft as nothing to screen", async () => {
    // Not a judgement that it is clean — there is no content, and it could not
    // be posted anyway. Answering here avoids spending the caller's rate budget.
    expect(await screenDraft("   ")).toEqual({ ok: true });
    expect(await screenDraft("")).toEqual({ ok: true });
  });

  it("screens the TRIMMED content, so padding cannot smuggle anything", async () => {
    expect(await screenDraft("\n\n  forbidden-example-phrase  \n")).toEqual({ ok: false });
  });

  it("is not fooled by case", async () => {
    expect(await screenDraft("FORBIDDEN-EXAMPLE-PHRASE")).toEqual({ ok: false });
  });

  it("is permissive when no denylist is configured", async () => {
    // Matches `screenContent`: an unset list is a no-op, deliberately, because
    // over-blocking legal speech is the worse failure on this board. Recorded
    // here so the behaviour reads as a decision rather than an accident.
    process.env.CONTENT_DENYLIST = "";
    expect(await screenDraft("anything at all, forbidden-example-phrase included")).toEqual({
      ok: true,
    });
  });

  /**
   * ⚠ THIS RUNS LAST ON PURPOSE, AND THE ORDER IS LOAD-BEARING. The rate
   * limiter is module-level and in-memory, so exhausting the window for this IP
   * refuses every call that follows it in this file. Moving it up fails the
   * tests after it, for a reason that looks nothing like the cause.
   */
  it("FAILS CLOSED when the caller is throttled", async () => {
    /**
     * ⚠ THE MOST IMPORTANT TEST HERE. This action is a denylist oracle —
     * `CONTENT_DENYLIST` is deliberately uncommitted, and enough calls would
     * map it. The rate limit is the defence, and a limiter that answers `ok`
     * when it gives up is worse than no limiter at all, because the client
     * treats `ok` as permission to broadcast.
     *
     * The window is 60 a minute on one IP, so exhausting it is the test.
     */
    let sawRefusal = false;
    for (let i = 0; i < 120; i++) {
      const r = await screenDraft(`clean draft number ${i}`);
      if (!r.ok) {
        sawRefusal = true;
        break;
      }
    }
    expect(sawRefusal).toBe(true);
  });
});
