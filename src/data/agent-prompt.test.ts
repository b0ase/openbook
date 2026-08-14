/**
 * Agent prompt assembly.
 *
 * Reads the real project MDs from disk (vitest runs with cwd = project root),
 * so these also fail if a doc the router points at is renamed or deleted —
 * which is the failure mode that would otherwise be invisible until a user
 * asked the agent a question and got an answer built on nothing.
 */

import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "./agent-prompt";

describe("buildAgentPrompt — base context", () => {
  it("always includes CLAUDE.md", () => {
    expect(buildAgentPrompt("hello")).toContain("--- CLAUDE.md ---");
  });

  it("carries the personality regardless of the question", () => {
    expect(buildAgentPrompt("anything")).toContain("You are the OpenBook agent");
  });
});

describe("buildAgentPrompt — the token guardrails", () => {
  // ⚠ These are the safety-relevant assertions. An agent that tells someone they
  // can buy or profit from a token that does not exist is a mis-sale in a
  // conversational wrapper, which is worse than the same claim on a page.

  it("instructs the agent that there is no token", () => {
    const p = buildAgentPrompt("how do tokens work?");
    expect(p).toContain("NEVER describe tokens as something anyone can buy");
    expect(p).toContain("There's no token yet");
  });

  it("forbids investment framing", () => {
    const p = buildAgentPrompt("should I get in early?");
    expect(p).toContain("NEVER suggest that contributing now will be worth more later");
  });

  it("states what is live and what is not", () => {
    const p = buildAgentPrompt("what can I do here?");
    expect(p).toContain("WORKING TODAY");
    expect(p).toContain("NOT BUILT YET");
  });

  it("explains the OpenCook name in the docs rather than leaving it confusing", () => {
    expect(buildAgentPrompt("what is this?")).toContain("fork of a project called OpenCook");
  });
});

describe("buildAgentPrompt — routing", () => {
  it("routes token questions to TOKENS.md, not just FAIRNESS.md", () => {
    // ⚠ ORDER-DEPENDENT. "token" questions also match the FAIRNESS pattern via
    // "earn"/"contribut". TOKENS.md is registered first so it wins the cap; if
    // the routes are ever reordered, this fails.
    const p = buildAgentPrompt("how do I earn tokens?");
    expect(p).toContain("--- TOKENS.md ---");
  });

  it.each([
    ["how does minting work", "TOKENS.md"],
    ["can I buy a stake", "TOKENS.md"],
    ["how do replies work", "THREADS.md"],
    ["can a post branch into a sub-project", "THREADS.md"],
    ["how do I earn money", "FAIRNESS.md"],
    ["what is the roadmap", "ROADMAP.md"],
    ["is my key safe", "SECURITY_AUDIT.md"],
    ["what is the vision", "DIRECTION.md"],
  ])("routes %j to %s", (question, doc) => {
    expect(buildAgentPrompt(question)).toContain(`--- ${doc} ---`);
  });

  it("caps context at three documents", () => {
    // Every route matches at once; the cap keeps the prompt from ballooning.
    const p = buildAgentPrompt("token thread earn roadmap security vision decision architecture");
    const count = (p.match(/^--- .*\.md ---$/gm) ?? []).length;
    expect(count).toBeLessThanOrEqual(3);
    expect(count).toBeGreaterThan(0);
  });

  it("loads only the base doc for an unrelated question", () => {
    const p = buildAgentPrompt("hi there");
    const count = (p.match(/^--- .*\.md ---$/gm) ?? []).length;
    expect(count).toBe(1);
  });

  it("actually loads document CONTENT, not just a header", () => {
    // loadMd swallows read errors and returns "". Without this, a renamed or
    // deleted doc would leave the agent with a heading and no facts under it,
    // and every other test here would still pass.
    const p = buildAgentPrompt("how do tokens work?");
    const body = p.split("--- TOKENS.md ---")[1] ?? "";
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("direction");
  });
});
