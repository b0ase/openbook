import type { NextConfig } from "next";

/**
 * ⚠ DEVELOPMENT ONLY — never true under `next build` / `next start`.
 *
 * React's DEVELOPMENT build requires `eval()` (callstack reconstruction across
 * environments, Fast Refresh). With the production `script-src` applied in dev,
 * every page load threw
 *
 *   "eval() is not supported in this environment. If this page was served with
 *    a Content-Security-Policy header, make sure that 'unsafe-eval' is included."
 *
 * and raised the Next.js error overlay. That is not cosmetic: a permanent
 * overlay MASKS REAL ERRORS while developing — anything genuinely broken hides
 * behind an error that is always there and always ignored.
 *
 * The production CSP is unchanged, byte for byte. `next-config.test.ts` asserts
 * that `'unsafe-eval'` can never appear in a production header, so this cannot
 * silently leak into a deploy.
 */
const IS_DEV = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    resolveAlias: {
      crypto: { browser: "./empty-module.mjs" },
      https: { browser: "./empty-module.mjs" },
      http: { browser: "./empty-module.mjs" },
      stream: { browser: "./empty-module.mjs" },
      buffer: { browser: "./empty-module.mjs" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        https: false,
        http: false,
        stream: false,
        buffer: false,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Production: 'self' 'unsafe-inline' — unchanged. `'unsafe-eval'`
              // is appended in DEV ONLY; see IS_DEV above for why, and
              // next-config.test.ts for the guard that keeps it out of prod.
              `script-src 'self' 'unsafe-inline'${IS_DEV ? " 'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              // ⚠ DELIBERATE RELAXATION, ADDED WITH LINK PREVIEWS. `https:` admits
              // images from any origin, which is what an og:image is by nature —
              // it points at whatever host the linked page lives on, so no
              // allowlist is possible. Without this the preview card renders a
              // permanently empty thumbnail box and the CSP violation is only
              // visible in the browser console.
              //
              // What this does NOT open up: images cannot execute script, and
              // `script-src` is untouched. The residual cost is that a linked
              // host learns a viewer's IP and coarse timing — limited by
              // `referrerPolicy="no-referrer"` on the <img> in LinkPreviewCard,
              // so it learns nothing about WHICH page they were reading.
              //
              // The alternative — proxying images through our own origin to keep
              // `img-src 'self'` — was rejected: it makes the server an open
              // image proxy anyone can point at any URL, on our bandwidth. That
              // is a worse trade than the one taken here.
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https://api.whatsonchain.com https://arc.taal.com https://arc.gorillapool.io",
              "font-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
