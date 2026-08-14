/**
 * Guards the ONE security-relevant conditional in `next.config.ts`.
 *
 * `'unsafe-eval'` is appended to `script-src` in development, because React's
 * dev build needs `eval()` and without it every dev page load throws and pins
 * the Next.js error overlay open — which masks real errors.
 *
 * The risk that buys is that it leaks into a production deploy, where
 * `'unsafe-eval'` meaningfully weakens the CSP: it lets injected strings become
 * executable code, turning a content-injection bug into script execution on a
 * page that handles a private key. A comment saying "dev only" does not enforce
 * anything; this does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Load next.config.ts fresh under a given NODE_ENV and return its CSP string. */
async function cspFor(nodeEnv: string): Promise<string> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  // The flag is read at module scope, so the module must be re-evaluated.
  vi.resetModules();
  const mod = await import("../../next.config");
  const config = mod.default as {
    headers: () => Promise<{ headers: { key: string; value: string }[] }[]>;
  };
  const groups = await config.headers();
  const csp = groups.flatMap((g) => g.headers).find((h) => h.key === "Content-Security-Policy");
  if (!csp) throw new Error("no Content-Security-Policy header found");
  return csp.value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CSP script-src", () => {
  it("NEVER allows unsafe-eval in production", async () => {
    const csp = await cspFor("production");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows unsafe-eval in development, so React's dev build works", async () => {
    const csp = await cspFor("development");
    expect(csp).toContain("'unsafe-eval'");
  });

  it("is production-strict for any NODE_ENV that is not development", async () => {
    // The gate is `!== "production"`, so `test` also gets it — assert the
    // production value explicitly rather than inferring from the negation.
    const prod = await cspFor("production");
    expect(prod).toContain("script-src 'self' 'unsafe-inline'");
    expect(prod).not.toContain("unsafe-eval");
  });

  it("keeps the rest of the production CSP intact", async () => {
    // Regression net: these directives were each added deliberately (link
    // previews needed `img-src https:`, the money path needs the ARC/WoC hosts).
    const csp = await cspFor("production");
    for (const directive of [
      "default-src 'self'",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://api.whatsonchain.com",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
