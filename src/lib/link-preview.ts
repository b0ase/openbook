/**
 * Link preview — the PURE half. URL extraction, SSRF address screening, and
 * OpenGraph parsing. No network, no DOM, no database; every function here is a
 * total function over its inputs so it can be tested exhaustively.
 *
 * The network half lives in `src/services/link-unfurl.ts` and consumes these.
 *
 * ⚠ WHY THIS FILE IS PARANOID. Unfurling means the SERVER fetches a URL that a
 * STRANGER typed. That is server-side request forgery by construction: absent a
 * guard, `http://169.254.169.254/latest/meta-data/` makes the server read its own
 * cloud credentials and render them into the public feed. Nothing else in this
 * codebase takes an attacker-controlled destination, so the usual review instincts
 * do not cover it.
 */

// ── URL extraction ──────────────────────────────────────────────────────────

/** Only these schemes are ever fetched. `file:`, `gopher:`, `ftp:` etc. are out. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Trailing characters that are almost always prose, not part of the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Pull http(s) URLs out of post text, in order, deduplicated.
 *
 * Deliberately conservative: a bare `example.com` is NOT a link. Requiring an
 * explicit scheme keeps the fetcher off anything the author did not clearly mean
 * as a URL, and keeps the extractor from having to guess at TLDs.
 */
export function extractUrls(content: string, limit = 4): string[] {
  if (!content) return [];
  const matches = content.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of matches) {
    // Strip prose punctuation that the regex greedily absorbed: "see https://x.com."
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    const normalized = normalizeUrl(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Canonical form used for dedupe and as the cache key. Returns null if the input
 * is not a usable http(s) URL.
 *
 * Drops the fragment (never sent to the server, so it cannot change the response)
 * but KEEPS the query string, which routinely does.
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;
  url.hash = "";
  return url.toString();
}

// ── SSRF address screening ──────────────────────────────────────────────────

/**
 * Is this resolved IP one the server must refuse to talk to?
 *
 * Screening happens on the RESOLVED ADDRESS, never the hostname — a hostname
 * check is defeated by any attacker-controlled domain with an A record pointing
 * at 127.0.0.1, which costs nothing to set up.
 *
 * Returns true to BLOCK. Unparseable input blocks: an address we cannot classify
 * is one we cannot clear.
 */
export function isBlockedAddress(ip: string): boolean {
  if (!ip) return true;
  const addr = ip.trim().toLowerCase();

  // IPv4-mapped and IPv4-compatible IPv6 (::ffff:127.0.0.1) — unwrap and screen
  // the embedded v4, or loopback walks straight through the v6 branch.
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);

  if (addr.includes(":")) return isBlockedIpv6(addr);
  return isBlockedIpv4(addr);
}

function isBlockedIpv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return true;

  const octets = parts.map((p) => {
    // Reject anything non-canonical rather than letting Number() be generous:
    // "0177.0.0.1" is octal loopback in some resolvers, and "1e2" parses as 100.
    if (!/^\d{1,3}$/.test(p)) return Number.NaN;
    return Number(p);
  });
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;

  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — AWS/GCP metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast

  return false;
}

function isBlockedIpv6(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "");
  if (a === "::" || a === "::1") return true; // unspecified, loopback

  const head = a.split(":")[0];
  if (!head) return true; // leading "::" — unspecified-ish, refuse

  const first = Number.parseInt(head, 16);
  if (Number.isNaN(first)) return true;

  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (first === 0x2001 && a.startsWith("2001:db8")) return true; // documentation
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

// ── OpenGraph parsing ───────────────────────────────────────────────────────

export interface OgData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Longest value we will keep for any single field. Bounds DB rows and layout. */
const MAX_FIELD_LENGTH = 500;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

function clean(value: string | null): string | null {
  if (value == null) return null;
  const out = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.length > MAX_FIELD_LENGTH ? `${out.slice(0, MAX_FIELD_LENGTH - 1)}…` : out;
}

/**
 * Read one meta tag's content by property/name.
 *
 * Handles both attribute orders (`property` before or after `content`) and both
 * quote styles, because real pages use every combination. This is a regex over
 * bounded input rather than a parser — the fetcher caps the body size, and a
 * dependency-free reader is worth more here than full HTML correctness.
 */
function readMeta(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`,
        "i"
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\s(?:property|name)\\s*=\\s*["']${k}["']`,
        "i"
      ),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) {
        const value = clean(m[1]);
        if (value) return value;
      }
    }
  }
  return null;
}

/**
 * Extract preview metadata, preferring OpenGraph and falling back to Twitter
 * cards and then plain HTML. A page with no OG tags at all still yields a usable
 * title, which is most of the value.
 */
export function parseOpenGraph(html: string): OgData {
  const title =
    readMeta(html, ["og:title", "twitter:title"]) ??
    clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null);

  return {
    title,
    description: readMeta(html, ["og:description", "twitter:description", "description"]),
    image: readMeta(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]),
    siteName: readMeta(html, ["og:site_name", "application-name"]),
  };
}

/**
 * Resolve a possibly-relative og:image against the page it came from, and refuse
 * anything that is not http(s) — `javascript:` and `data:` URLs in og:image are a
 * known way to smuggle payloads into a renderer.
 */
export function resolveImageUrl(image: string | null, pageUrl: string): string | null {
  if (!image) return null;
  try {
    const resolved = new URL(image, pageUrl);
    if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) return null;
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}
