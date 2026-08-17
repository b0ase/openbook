import { describe, expect, it } from "vitest";
import { parseDenylist, screenContent } from "./content-filter";

describe("content-filter", () => {
  it("permits any content when the denylist is unconfigured (best-effort, permissive by design)", () => {
    expect(screenContent("anything goes here", undefined).ok).toBe(true);
    expect(screenContent("anything", "").ok).toBe(true);
    expect(screenContent("anything", "   \n # only a comment").ok).toBe(true);
  });

  it("blocks a substring pattern, case-insensitively", () => {
    const list = "badword";
    expect(screenContent("this has a BadWord in it", list)).toEqual({
      ok: false,
      reason: "denylisted",
    });
    expect(screenContent("a totally clean builder post", list).ok).toBe(true);
  });

  it("blocks a regex pattern (/slashes/) and leaves clean content alone", () => {
    const list = "/foo.?bar/";
    expect(screenContent("foo bar", list).ok).toBe(false);
    expect(screenContent("foobar", list).ok).toBe(false);
    expect(screenContent("foo then later baz", list).ok).toBe(true);
  });

  it("parses multi-line + comma lists, ignores blanks/comments, skips malformed regex", () => {
    const raw = "# a comment\n\nalpha\n/be+ta/\n/(/";
    const patterns = parseDenylist(raw);
    expect(patterns.length).toBe(2); // alpha (substring) + /be+ta/ (regex); malformed /(/ skipped
    expect(screenContent("ALPHA here", raw).ok).toBe(false);
    expect(screenContent("beeeta", raw).ok).toBe(false);
    expect(screenContent("a clean post", raw).ok).toBe(true);
  });

  it("supports comma-separated patterns", () => {
    expect(screenContent("contains x2 here", "x1,x2,x3").ok).toBe(false);
    expect(screenContent("contains none", "x1,x2,x3").ok).toBe(true);
  });
});

/**
 * Commas inside a pattern.
 *
 * ⚠ THE REGRESSION THIS PINS. The splitter was `raw.split(/[\n,]/)`, so a regex
 * quantifier — the one place a comma legitimately appears — cut the pattern in
 * two. Both halves then failed the "starts and ends with /" test and became
 * substring rules matching nothing, with no warning, because nothing was
 * malformed. The control silently stopped working.
 */
describe("commas inside a pattern", () => {
  it("keeps a regex quantifier intact", () => {
    const parsed = parseDenylist("/\\d{2,4}-scam/");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("regex");
    expect(screenContent("ref 1234-scam here", "/\\d{2,4}-scam/").ok).toBe(false);
    expect(screenContent("nothing to see", "/\\d{2,4}-scam/").ok).toBe(true);
  });

  it("still separates patterns on commas BETWEEN regexes", () => {
    const parsed = parseDenylist("/alpha/,/beta/");
    expect(parsed).toHaveLength(2);
    expect(parsed.every((p) => p.kind === "regex")).toBe(true);
    expect(screenContent("a beta thing", "/alpha/,/beta/").ok).toBe(false);
  });

  it("mixes quantifiers and separators without confusion", () => {
    const raw = "/a{1,2}/,plain text,/b{3,4}/";
    const parsed = parseDenylist(raw);
    expect(parsed.map((p) => p.kind)).toEqual(["regex", "substring", "regex"]);
    expect(screenContent("aa", raw).ok).toBe(false);
    expect(screenContent("PLAIN TEXT", raw).ok).toBe(false);
    expect(screenContent("bbbb", raw).ok).toBe(false);
    // No "a", no "b", and not the substring — the only string here that is clean.
    expect(screenContent("nothing to see", raw).ok).toBe(true);
  });

  it("does NOT promote a slash-containing substring to a regex", () => {
    // `/path/to/thing` has a leading slash but does not END on a matching one —
    // it was a substring before this change and must stay one.
    const parsed = parseDenylist("/path/to/thing");
    expect(parsed).toEqual([{ kind: "substring", text: "/path/to/thing" }]);
  });

  it("treats an escaped slash inside a regex as literal", () => {
    const parsed = parseDenylist("/a\\/b/");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("regex");
    expect(screenContent("xxa/bxx", "/a\\/b/").ok).toBe(false);
  });

  it("does not let a regex swallow the next line", () => {
    const parsed = parseDenylist("/unterminated\nplain");
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.kind)).toEqual(["substring", "substring"]);
  });

  it("keeps comments and blanks working across both forms", () => {
    const parsed = parseDenylist("# a note\n\n/x{1,2}/\n# another\nplain");
    expect(parsed.map((p) => p.kind)).toEqual(["regex", "substring"]);
  });
});
