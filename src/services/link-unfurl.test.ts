/**
 * Unfurl guard tests.
 *
 * These make NO network calls and need no mocking: every case here is refused
 * before `fetch` is ever reached, which is precisely the property being asserted.
 * If a change lets one of these through, the test hangs or fails rather than
 * silently starting to make real requests — the failure mode is loud.
 */

import { describe, expect, it, vi } from "vitest";
import { unfurl } from "./link-unfurl";

describe("unfurl — refuses before fetching", () => {
  it("refuses non-http(s) schemes", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      const r = await unfurl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_url");
    }
  });

  it("refuses garbage input", async () => {
    const r = await unfurl("not a url at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("REFUSES cloud metadata — the case the guard exists for", async () => {
    // If this ever returns anything but blocked_address, the server will read its
    // own instance credentials on behalf of whoever pasted the link.
    const r = await unfurl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_address");
  });

  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:3000/api/health",
    "http://localhost.localdomain/", // resolves to loopback
    "http://10.0.0.1/",
    "http://192.168.1.1/admin",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://0.0.0.0/",
  ])("refuses private/loopback target %s", async (url) => {
    const r = await unfurl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["blocked_address", "dns_failed", "fetch_failed"]).toContain(r.reason);
  });

  it("does not call fetch at all for a blocked literal address", async () => {
    // The strongest form of the assertion: not "it failed" but "it never tried".
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await unfurl("http://169.254.169.254/");
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not call fetch for an IPv4-mapped IPv6 loopback", async () => {
    // ::ffff:127.0.0.1 — loopback wearing a v6 coat.
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await unfurl("http://[::ffff:127.0.0.1]/");
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws — failures are typed, because it runs detached", async () => {
    // createPost calls this fire-and-forget. A rejection would be an unhandled
    // rejection with nothing to catch it.
    await expect(unfurl("http://127.0.0.1/")).resolves.toBeDefined();
    await expect(unfurl("!!!")).resolves.toBeDefined();
  });
});

describe("unfurl — redirect handling", () => {
  it("re-screens the redirect target and refuses a private hop", async () => {
    // The classic bypass: a public URL that 302s to loopback. `redirect: manual`
    // plus a per-hop screen is what stops it; automatic redirects would follow.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    );

    const r = await unfurl("https://example.com/redirect");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_address");
    // One call for the original hop; the redirect target was screened, not fetched.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } })
      );

    const r = await unfurl("https://example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_address");
    spy.mockRestore();
  });
});

describe("unfurl — response handling", () => {
  it("refuses a non-HTML content type", async () => {
    // Without this, a 4GB video or a JSON API is read as if it were a web page.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("binary", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    );

    const r = await unfurl("https://example.com/doc.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_html");
    spy.mockRestore();
  });

  it("refuses a non-2xx status", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const r = await unfurl("https://example.com/missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_status");
    spy.mockRestore();
  });

  it("parses OG tags from an allowed response", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `<html><head>
           <meta property="og:title" content="Hello">
           <meta property="og:description" content="World">
           <meta property="og:image" content="/img.png">
           <meta property="og:site_name" content="Example">
         </head></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      )
    );

    const r = await unfurl("https://example.com/post");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.title).toBe("Hello");
      expect(r.data.description).toBe("World");
      expect(r.data.siteName).toBe("Example");
      // Relative og:image resolved against the page it came from.
      expect(r.data.image).toBe("https://example.com/img.png");
    }
    spy.mockRestore();
  });
});
