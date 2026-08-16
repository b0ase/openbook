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

/**
 * One identifier per build, readable from BOTH the client bundle and the server.
 *
 * ⚠ WHY THIS EXISTS: a tab left open across a deploy keeps working just enough
 * to be confusing. Feed polling goes through a ROUTE HANDLER, which survives a
 * deploy, so posts keep arriving and the page looks perfectly alive — while
 * every SERVER ACTION the old bundle knows about has been replaced and now fails
 * with `UnrecognizedActionError`. In practice that meant claiming a name, opening
 * a ticker, and transferring one all failed with generic "try again" copy, and
 * one of them failed SILENTLY (an owned-names list that catches the error and
 * renders an empty section, so the feature simply appears not to exist).
 *
 * Baked in at build time so the client's copy is frozen into its bundle while
 * the server always reports the running build — a mismatch is therefore exactly
 * "this tab is older than the server", which is the condition worth telling the
 * user about. Prefers the deploy's commit SHA where the host provides one so the
 * value is meaningful in logs; falls back to build time, which only has to be
 * unique per build, not descriptive.
 */
const BUILD_ID =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  String(Date.now());

const nextConfig: NextConfig = {
  generateBuildId: () => BUILD_ID,
  // Inlined into the client bundle at build time. Read via `CLIENT_BUILD_ID`
  // in `src/lib/build-id.ts` rather than directly, so there is one spelling.
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
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
              // ⚠ SAME TRADE AS img-src ABOVE, made knowingly. Posted media lives
              // on whatever host the poster used, so no allowlist is possible.
              // Without this, <video>/<audio> fall back to `default-src 'self'`
              // and every embed is silently blocked. Media cannot execute script,
              // and `script-src` is untouched. The residual cost is the same one
              // img-src already accepts: the host learns a viewer's IP, bounded by
              // referrerPolicy="no-referrer" and `preload="none"`.
              "media-src 'self' https: blob:",
              // `ordinals.gorillapool.io` is the ORDINALS broadcast + policy host: a
              // paid post goes there first so the inscription is indexed promptly.
              // Without it here the POST is blocked by CSP and reads as a rejected
              // broadcast rather than a blocked request.
              "connect-src 'self' https://api.whatsonchain.com https://arc.taal.com https://arc.gorillapool.io https://ordinals.gorillapool.io",
              "font-src 'self'",
              // ⚠ AN ALLOWLIST, NOT `https:` LIKE img-src AND media-src ABOVE.
              // Those two accept any host because posted media lives wherever
              // the poster put it, and the trade is safe because an image or a
              // video CANNOT EXECUTE SCRIPT. A frame can. So framing is limited
              // to the finite set of hosts we actually embed, and adding one is
              // a deliberate decision rather than a consequence of somebody
              // pasting a link. Without any frame-src the directive falls back
              // to `default-src 'self'` and every embed is silently blocked —
              // which is what happened before this line existed.
              "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
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
