import { describe, expect, it } from "vitest";
import { parsePostHref, postHref, postUrl } from "./post-href";

describe("postHref", () => {
  it("addresses a post by id", () => {
    expect(postHref(1)).toBe("/p/1");
    expect(postHref(2024)).toBe("/p/2024");
  });

  it("round-trips through the parser", () => {
    for (const id of [1, 7, 2024, 999999]) {
      expect(parsePostHref(postHref(id))).toBe(id);
    }
  });
});

describe("parsePostHref", () => {
  it("reads a post id", () => {
    expect(parsePostHref("/p/123")).toBe(123);
  });

  // The parser decides whether an overlay reopens on Back, so everything that
  // is not exactly a post address has to answer "no".
  it.each([
    "/",
    "/p",
    "/p/",
    "/p/abc",
    "/p/1.5",
    "/p/-1",
    "/p/0",
    "/p/12/extra",
    "/products/1",
    "/$memeplex",
    "/leaderboard/$memeplex",
    "/p/1?x=2",
  ])("is not a post address: %s", (pathname) => {
    expect(parsePostHref(pathname)).toBeNull();
  });
});

describe("postUrl", () => {
  it("builds a pasteable absolute link", () => {
    expect(postUrl("https://openbooks.space", 42)).toBe("https://openbooks.space/p/42");
  });

  it("does not double the slash when the origin carries one", () => {
    expect(postUrl("https://openbooks.space/", 42)).toBe("https://openbooks.space/p/42");
  });
});
