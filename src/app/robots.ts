import type { MetadataRoute } from "next";

/**
 * Dynamic robots.txt.
 *
 * Indexing is OFF by default (early-access / quiet launch) so a rough
 * openbooks.space can't be crawled/indexed. Going public = set ALLOW_INDEXING=true
 * (one env var, no code change — see LAUNCH_CHECKLIST Stage 4). Mirrors the
 * `robots` meta tag in layout.tsx; keep the two in sync.
 *
 * ⚠ THIS ALSO CONTROLS EVERY SOCIAL PREVIEW, NOT JUST GOOGLE. Twitterbot,
 * facebookexternalhit and the rest read robots.txt before fetching, so
 * `Disallow: /` means no card renders anywhere — with no error and nothing in
 * any log to explain it. On 2026-08-18 the Twitter card was blank while the
 * tags, the absolute `og:image` and the image itself were all perfectly
 * correct. The quiet-launch decision reasoned about search indexing alone and
 * did not anticipate this. If the card is ever empty again, read this file
 * first.
 */

/**
 * ⚠ REQUEST-TIME, AND IT HAS TO BE — `ALLOW_INDEXING` CANNOT REACH A BUILD.
 *
 * `robots.ts` is a Route Handler that Next CACHES BY DEFAULT, so without this
 * the file is generated once during `next build` and served forever after.
 * That build runs inside the Dockerfile (`RUN npm run build`), where Railway's
 * service variables do not exist — so `process.env.ALLOW_INDEXING` is
 * undefined there no matter what the dashboard says, and the baked answer is
 * always `Disallow: /`.
 *
 * This cost a full cycle to find. Setting the variable did nothing; a
 * `railway redeploy` did nothing (it reuses the built image); and a fresh
 * build from a push did nothing either, because the variable still was not in
 * the Docker build environment. Meanwhile the `robots` META TAG in layout.tsx
 * flipped correctly on its own, because the page is ISR and re-renders at
 * RUNTIME where the variable does exist — so one half of a single switch
 * worked and the other half silently did not.
 *
 * Forcing request-time evaluation makes both halves read the same environment
 * at the same moment. The alternative — an `ARG`/`ENV` pair in the Dockerfile —
 * would work too, but it leaves a config switch whose behaviour depends on the
 * host passing build args, which is precisely the trap this comment exists to
 * describe. robots.txt is fetched rarely; rendering it per request costs
 * nothing worth measuring.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const allowIndexing = process.env.ALLOW_INDEXING === "true";
  return allowIndexing
    ? { rules: { userAgent: "*", allow: "/", disallow: "/api/" } }
    : { rules: { userAgent: "*", disallow: "/" } };
}
