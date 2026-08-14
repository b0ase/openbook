import { describe, expect, it } from "vitest";
import { findSegments, findUrls } from "./linkify";

const urls = (s: string) => findUrls(s).map((u) => u.url);

describe("findUrls", () => {
  it("finds a bare url", () => {
    expect(urls("see https://example.com now")).toEqual(["https://example.com"]);
  });

  it("finds several", () => {
    expect(urls("https://a.com and http://b.org")).toEqual(["https://a.com", "http://b.org"]);
  });

  it("keeps query strings and paths intact", () => {
    expect(urls("https://www.bitcoinchat.online/chat?room=OPENCOOK")).toEqual([
      "https://www.bitcoinchat.online/chat?room=OPENCOOK",
    ]);
  });

  it("trims trailing sentence punctuation", () => {
    // "see https://example.com." should link to the site, not to site-plus-dot.
    expect(urls("see https://example.com.")).toEqual(["https://example.com"]);
    expect(urls("(https://example.com)")).toEqual(["https://example.com"]);
    expect(urls("https://example.com, and more")).toEqual(["https://example.com"]);
  });

  it("ignores non-http schemes entirely", () => {
    // Scheme ALLOWLIST: a javascript: or data: URL rendered as a clickable link
    // would be stored XSS with a permanent on-chain copy.
    expect(urls("javascript:alert(1)")).toEqual([]);
    expect(urls("data:text/html;base64,PHNjcmlwdD4=")).toEqual([]);
    expect(urls("ftp://files.example.com")).toEqual([]);
  });

  it("ignores bare domains with no scheme", () => {
    expect(urls("visit example.com please")).toEqual([]);
  });
});

describe("findSegments", () => {
  it("returns urls and tickers in document order", () => {
    const segs = findSegments("$Alpha then https://example.com then $Beta");
    expect(segs.map((s) => s.kind)).toEqual(["ticker", "url", "ticker"]);
  });

  it("does NOT carve a ticker out of a url path", () => {
    // Otherwise the href breaks AND a claim appears that nobody made.
    const segs = findSegments("https://example.com/$OpenBook");
    expect(segs.map((s) => s.kind)).toEqual(["url"]);
    expect(segs[0].kind === "url" && segs[0].url).toBe("https://example.com/$OpenBook");
  });

  it("still finds a ticker outside a url on the same line", () => {
    const segs = findSegments("https://example.com/$Inside and $Outside");
    expect(segs.map((s) => s.kind)).toEqual(["url", "ticker"]);
    expect(segs[1].kind === "ticker" && segs[1].symbol).toBe("OUTSIDE");
  });

  it("segments never overlap", () => {
    const segs = findSegments("$A https://x.com/$B $C");
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end);
    }
  });

  it("returns nothing for plain text", () => {
    expect(findSegments("just some words about $5 coffee")).toEqual([]);
  });
});
