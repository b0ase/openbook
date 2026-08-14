/**
 * Slash-command parsing.
 *
 * The asymmetry drives every case here: mistaking a command for a post is
 * recoverable noise, but mistaking a POST for a command silently swallows
 * something somebody wrote — and posts are permanent.
 */

import { describe, expect, it } from "vitest";
import { isSlashCommand, parseSlashCommand } from "./slash";

describe("parseSlashCommand", () => {
  it("reads the command and its argument", () => {
    expect(parseSlashCommand("/agent what is this thread about?")).toEqual({
      name: "agent",
      arg: "what is this thread about?",
    });
  });

  it("accepts the bare command with no argument", () => {
    expect(parseSlashCommand("/agent")).toEqual({ name: "agent", arg: "" });
    expect(parseSlashCommand("/agent   ")).toEqual({ name: "agent", arg: "" });
  });

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseSlashCommand("  /AGENT hello")).toEqual({ name: "agent", arg: "hello" });
    expect(parseSlashCommand("/Agent hello")).toEqual({ name: "agent", arg: "hello" });
  });

  it("does NOT swallow a post that merely starts with a slash", () => {
    // Each of these is somebody's writing. Treating one as a command would
    // discard it, and a post cannot be un-lost.
    expect(parseSlashCommand("/agentic fairness was the old subtitle")).toBeNull();
    expect(parseSlashCommand("/ agent")).toBeNull();
    expect(parseSlashCommand("//agent")).toBeNull();
    expect(parseSlashCommand("/notacommand do a thing")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
  });

  it("does NOT match a command that is not at the start", () => {
    expect(parseSlashCommand("ask the /agent about this")).toBeNull();
    expect(parseSlashCommand("https://example.com/agent/docs")).toBeNull();
  });

  it("is null for ordinary text", () => {
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("a normal post")).toBeNull();
    expect(parseSlashCommand("$TICKER and some words")).toBeNull();
  });

  it("keeps the argument verbatim apart from surrounding whitespace", () => {
    // The caller must never re-slice the raw text — that is how two places end
    // up disagreeing about where the command ended.
    expect(parseSlashCommand("/agent  what about $OPENBOOKS/$MEMEPLEX ?  ")?.arg).toBe(
      "what about $OPENBOOKS/$MEMEPLEX ?"
    );
  });
});

describe("isSlashCommand", () => {
  it("agrees with the parser", () => {
    expect(isSlashCommand("/agent hi")).toBe(true);
    expect(isSlashCommand("/agentic")).toBe(false);
    expect(isSlashCommand("hello")).toBe(false);
  });
});
