import { describe, expect, it } from "vitest";
import {
  extractUrls,
  isBlockedAddress,
  normalizeUrl,
  parseOpenGraph,
  resolveImageUrl,
} from "./link-preview";

describe("extractUrls", () => {
  it("finds http and https URLs in order", () => {
    expect(extractUrls("see http://a.com and https://b.com")).toEqual([
      "http://a.com/",
      "https://b.com/",
    ]);
  });

  it("ignores bare domains — an explicit scheme is required", () => {
    expect(extractUrls("visit example.com or www.example.com")).toEqual([]);
  });

  it("strips trailing prose punctuation", () => {
    // "Read https://example.com." — the period is a sentence, not a path.
    expect(extractUrls("Read https://example.com.")).toEqual(["https://example.com/"]);
    expect(extractUrls("(https://example.com/x)")).toEqual(["https://example.com/x"]);
    expect(extractUrls("is it https://example.com?")).toEqual(["https://example.com/"]);
  });

  it("deduplicates equivalent URLs", () => {
    expect(extractUrls("https://a.com https://a.com/ https://a.com#frag")).toEqual([
      "https://a.com/",
    ]);
  });

  it("keeps the query string but drops the fragment", () => {
    // The query changes the response; the fragment is never sent to the server.
    expect(extractUrls("https://a.com/p?id=1#section")).toEqual(["https://a.com/p?id=1"]);
  });

  it("caps how many URLs one post can yield", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://x${i}.com`).join(" ");
    expect(extractUrls(many)).toHaveLength(4);
    expect(extractUrls(many, 2)).toHaveLength(2);
  });

  it("ignores non-http schemes", () => {
    expect(extractUrls("file:///etc/passwd ftp://x.com javascript:alert(1)")).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(extractUrls("")).toEqual([]);
    expect(extractUrls("no links here")).toEqual([]);
  });
});

describe("normalizeUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("data:text/html,<script>")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });
});

describe("isBlockedAddress — the SSRF screen", () => {
  // ⚠ Screening is on the RESOLVED ADDRESS. A hostname check is defeated by any
  // attacker-controlled domain with an A record pointing at 127.0.0.1.

  it("blocks cloud metadata (the case this exists for)", () => {
    // http://169.254.169.254/latest/meta-data/ — AWS/GCP/Azure credentials.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback (whole /8)"],
    ["169.254.1.1", "link-local"],
    ["172.16.0.1", "private lower bound"],
    ["172.31.255.255", "private upper bound"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "CGNAT lower"],
    ["100.127.255.255", "CGNAT upper"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["93.184.216.34"],
    ["172.15.0.1"], // just BELOW the private range
    ["172.32.0.1"], // just ABOVE the private range
    ["100.63.255.255"], // just below CGNAT
    ["100.128.0.1"], // just above CGNAT
    ["11.0.0.1"],
  ])("allows public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 loopback — the bypass a v6-only branch misses", () => {
    // ::ffff:127.0.0.1 is loopback wearing a v6 coat. Screening the v6 form
    // without unwrapping the embedded v4 lets it straight through.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::127.0.0.1")).toBe(true);
  });

  it("allows an IPv4-mapped PUBLIC address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it.each([
    ["::1", "v6 loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
  ])("blocks IPv6 %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("2a00:1450:4009:81a::200e")).toBe(false);
  });

  it("blocks non-canonical IPv4 that some resolvers accept", () => {
    // "0177.0.0.1" is octal loopback to inet_aton; "1e2" parses as 100 under
    // Number(). Anything not plain decimal is refused rather than interpreted.
    expect(isBlockedAddress("0177.0.0.1")).toBe(true);
    expect(isBlockedAddress("1e2.0.0.1")).toBe(true);
    expect(isBlockedAddress("0x7f.0.0.1")).toBe(true);
    expect(isBlockedAddress("2130706433")).toBe(true); // decimal loopback
  });

  it("blocks anything unparseable — unclassifiable is uncleared", () => {
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("   ")).toBe(true);
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
    expect(isBlockedAddress("1.2.3")).toBe(true);
    expect(isBlockedAddress("1.2.3.4.5")).toBe(true);
    expect(isBlockedAddress("garbage")).toBe(true);
    expect(isBlockedAddress("-1.0.0.1")).toBe(true);
  });
});

describe("parseOpenGraph", () => {
  it("reads og tags in either attribute order", () => {
    const a = `<meta property="og:title" content="Order A">`;
    const b = `<meta content="Order B" property="og:title">`;
    expect(parseOpenGraph(a).title).toBe("Order A");
    expect(parseOpenGraph(b).title).toBe("Order B");
  });

  it("handles single quotes", () => {
    expect(parseOpenGraph(`<meta property='og:title' content='Single'>`).title).toBe("Single");
  });

  it("reads all four fields", () => {
    const html = `
      <meta property="og:title" content="T">
      <meta property="og:description" content="D">
      <meta property="og:image" content="https://x.com/i.png">
      <meta property="og:site_name" content="S">`;
    expect(parseOpenGraph(html)).toEqual({
      title: "T",
      description: "D",
      image: "https://x.com/i.png",
      siteName: "S",
    });
  });

  it("falls back to twitter cards, then to <title>", () => {
    expect(parseOpenGraph(`<meta name="twitter:title" content="Tw">`).title).toBe("Tw");
    expect(parseOpenGraph(`<title>Plain Title</title>`).title).toBe("Plain Title");
  });

  it("prefers og:title over the <title> tag", () => {
    const html = `<title>Fallback</title><meta property="og:title" content="Preferred">`;
    expect(parseOpenGraph(html).title).toBe("Preferred");
  });

  it("decodes HTML entities", () => {
    expect(parseOpenGraph(`<meta property="og:title" content="A &amp; B &#39;C&#39;">`).title).toBe(
      "A & B 'C'"
    );
  });

  it("collapses whitespace across newlines", () => {
    expect(parseOpenGraph(`<title>one\n   two\t three</title>`).title).toBe("one two three");
  });

  it("truncates absurdly long values", () => {
    const long = "x".repeat(2000);
    const title = parseOpenGraph(`<meta property="og:title" content="${long}">`).title;
    expect(title).toHaveLength(500);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("returns nulls for a page with no metadata", () => {
    expect(parseOpenGraph("<html><body>nothing</body></html>")).toEqual({
      title: null,
      description: null,
      image: null,
      siteName: null,
    });
  });

  it("treats an empty content attribute as absent", () => {
    expect(parseOpenGraph(`<meta property="og:title" content="">`).title).toBeNull();
  });
});

describe("resolveImageUrl", () => {
  it("resolves a relative image against the page", () => {
    expect(resolveImageUrl("/img/a.png", "https://x.com/post/1")).toBe("https://x.com/img/a.png");
    expect(resolveImageUrl("a.png", "https://x.com/post/")).toBe("https://x.com/post/a.png");
  });

  it("keeps an absolute image", () => {
    expect(resolveImageUrl("https://cdn.y.com/a.png", "https://x.com/")).toBe(
      "https://cdn.y.com/a.png"
    );
  });

  it("REFUSES javascript: and data: images", () => {
    // og:image is rendered by a browser; these are payload smuggling, not images.
    expect(resolveImageUrl("javascript:alert(1)", "https://x.com/")).toBeNull();
    expect(
      resolveImageUrl("data:image/svg+xml,<svg onload=alert(1)>", "https://x.com/")
    ).toBeNull();
  });

  it("returns null for missing or unparseable input", () => {
    expect(resolveImageUrl(null, "https://x.com/")).toBeNull();
    expect(resolveImageUrl("http://[bad", "https://x.com/")).toBeNull();
  });
});
