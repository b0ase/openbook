/**
 * The canonical public origin — the one answer to "what URL is this site at?".
 *
 * ⚠ THIS EXISTS BECAUSE GETTING IT WRONG IS SILENT AND TOTAL. Without an explicit
 * origin, Next builds absolute metadata URLs from the REQUEST HOST, and behind
 * Railway's proxy that host is `localhost:8080` — so every social card pointed at
 * `http://localhost:8080/opengraph-image`, which no scraper on earth can fetch.
 * The page still rendered, the tags still validated, and every shared link showed
 * a stale or missing card. Nothing failed loudly. Do not remove the fallback
 * chain below on the grounds that "the host header is right there".
 *
 * It also decides upload URLs, which are written into post text and anchored
 * on-chain verbatim — those cannot be edited afterwards, so a wrong answer here
 * is permanent rather than merely broken.
 *
 * Resolution order, most to least canonical:
 *  1. `SITE_ORIGIN` — set this. It is the only value that survives a domain move.
 *  2. `RAILWAY_PUBLIC_DOMAIN` — injected by Railway, so a fresh deploy is correct
 *     with zero configuration instead of defaulting to something unreachable.
 *  3. localhost — development only.
 */

const DEV_ORIGIN = "http://localhost:3000";

function clean(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function siteOrigin(): string {
  const explicit = process.env.SITE_ORIGIN?.trim();
  if (explicit) return clean(explicit);

  // Railway injects the service's public hostname (no scheme). Railway terminates
  // TLS at the edge, so https is correct even though the app itself serves plain
  // HTTP internally.
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return clean(railway.startsWith("http") ? railway : `https://${railway}`);

  return DEV_ORIGIN;
}

/** `true` when the origin is a real deployment rather than the dev fallback. */
export function hasCanonicalOrigin(): boolean {
  return Boolean(process.env.SITE_ORIGIN?.trim() || process.env.RAILWAY_PUBLIC_DOMAIN?.trim());
}
