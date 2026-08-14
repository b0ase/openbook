/**
 * Link unfurling — the NETWORK half. Fetches a user-supplied URL and extracts
 * preview metadata. The pure guards it depends on live in `lib/link-preview.ts`.
 *
 * ⚠ THIS IS THE ONLY PLACE THE SERVER FETCHES AN ATTACKER-CONTROLLED DESTINATION.
 * Every other outbound request in this codebase goes to a hardcoded host (ARC,
 * WhatsOnChain, Groq, Anthropic). Treat changes here as money-path changes.
 *
 * Defence in depth, in the order it applies:
 *   1. scheme allowlist          — http(s) only (`normalizeUrl`)
 *   2. DNS resolution + IP screen — EVERY resolved address must pass
 *   3. manual redirects           — each hop re-screened; no silent cross-host jump
 *   4. timeout                    — bounded wall clock
 *   5. content-type check         — HTML only
 *   6. size cap                   — streamed, stops reading past the limit
 *
 * ⚠ RESIDUAL RISK, STATED RATHER THAN PAPERED OVER: DNS REBINDING. We resolve,
 * screen the addresses, then let `fetch` resolve again when it connects. An
 * attacker controlling a domain with a very low TTL can answer public on the
 * first lookup and private on the second. Closing this needs a custom socket
 * `lookup` (undici's `Agent({ connect: { lookup } })`), and undici is not a
 * dependency here — Node's global fetch exposes no such hook. The window is
 * narrow and requires attacker-controlled authoritative DNS. If undici is ever
 * added, close it: that is the correct fix, not more hostname checks.
 */

import { promises as dns } from "node:dns";
import {
  isBlockedAddress,
  normalizeUrl,
  type OgData,
  parseOpenGraph,
  resolveImageUrl,
} from "@/lib/link-preview";

/** Wall-clock budget for one unfurl, redirects included. */
const TIMEOUT_MS = 5_000;
/** Stop reading after this much body. OG tags live in <head>; nobody needs more. */
const MAX_BYTES = 256 * 1024;
/** Redirect hops followed. Each one is re-screened. */
const MAX_REDIRECTS = 3;

export type UnfurlFailure =
  | "invalid_url"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "bad_status"
  | "not_html"
  | "timeout"
  | "fetch_failed";

export type UnfurlResult =
  | { ok: true; url: string; data: OgData }
  | { ok: false; url: string; reason: UnfurlFailure };

/**
 * Resolve a hostname and refuse if ANY returned address is blocked.
 *
 * "Any", not "the first": a hostname can carry several A/AAAA records, and a
 * resolver is free to hand back a different one than we screened. If even one is
 * private, the name is not safe to fetch.
 */
async function screenHostname(hostname: string): Promise<boolean> {
  // A bare IP literal in the URL never reaches a resolver — screen it directly.
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(literal) || literal.includes(":")) {
    return !isBlockedAddress(literal);
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every((a) => !isBlockedAddress(a.address));
}

/** Read at most MAX_BYTES of the body, then stop pulling. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: string[] = [];
  let total = 0;

  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Stop the transfer rather than draining a hostile endless response.
    await reader.cancel().catch(() => {});
  }
  return chunks.join("");
}

/**
 * Fetch a URL and extract preview metadata.
 *
 * Never throws — every failure is a typed `reason`, because this runs
 * fire-and-forget off the post path and a rejection there is invisible.
 */
export async function unfurl(rawUrl: string): Promise<UnfurlResult> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return { ok: false, url: rawUrl, reason: "invalid_url" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let current = normalized;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = new URL(current);

      // Re-screened on EVERY hop. A public URL redirecting to 127.0.0.1 is the
      // standard bypass; following redirects automatically would walk into it.
      if (!(await screenHostname(url.hostname))) {
        return { ok: false, url: normalized, reason: "blocked_address" };
      }

      let res: Response;
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            // Identify honestly, and ask for HTML. The URL is the point of the
            // `+` convention — an operator who sees this bot in their logs must
            // be able to reach a page explaining it, so it has to name the site
            // the bot actually runs from. It named a Vercel preview URL that no
            // longer serves anything.
            "User-Agent": "OpenBookBot/1.0 (+https://openbooks.space)",
            Accept: "text/html,application/xhtml+xml",
          },
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return { ok: false, url: normalized, reason: "timeout" };
        }
        return { ok: false, url: normalized, reason: "fetch_failed" };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, url: normalized, reason: "bad_status" };
        const next = normalizeUrl(new URL(location, current).toString());
        if (!next) return { ok: false, url: normalized, reason: "blocked_address" };
        current = next;
        continue;
      }

      if (!res.ok) return { ok: false, url: normalized, reason: "bad_status" };

      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(contentType)) {
        return { ok: false, url: normalized, reason: "not_html" };
      }

      const html = await readCapped(res);
      const data = parseOpenGraph(html);
      return {
        ok: true,
        url: normalized,
        // Resolve the image against the FINAL url, not the original — a redirect
        // changes what a relative path means.
        data: { ...data, image: resolveImageUrl(data.image, current) },
      };
    }

    return { ok: false, url: normalized, reason: "too_many_redirects" };
  } finally {
    clearTimeout(timer);
  }
}
