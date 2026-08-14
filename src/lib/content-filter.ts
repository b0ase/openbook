/**
 * Pre-publish content screen (Phase 3 — thin-core, ILLEGAL-FLOOR only).
 *
 * Runs in `createPost` BEFORE the DB insert + on-chain broadcast — the ONLY point
 * that can stop content reaching the IMMUTABLE chain (`onchain.ts` logs the post
 * fire-and-forget immediately after insert). Because the server signs + broadcasts
 * the OP_RETURN, this is the one control that keeps the operator from publishing
 * illegal material it can never delete.
 *
 * Scope is deliberately the ILLEGAL FLOOR, NOT editorial/offensive content — this is
 * NOT opinion moderation (the product is censorship-resistant by design; legal-but-
 * disagreeable speech stays). It is a best-effort, EXTENSIBLE hook + a documented
 * good-faith effort — NOT a comprehensive filter: a text denylist cannot reliably
 * catch novel or coded content. Its real value is (a) blocking known-bad patterns the
 * operator configures, (b) existing as the documented pre-publish control, and (c)
 * being trivially extensible the moment a specific bad pattern is discovered.
 *
 * The denylist is OPERATOR-SUPPLIED via the `CONTENT_DENYLIST` env var — deliberately
 * NOT committed to this public repo (avoids shipping a verbatim list of illegal terms,
 * and lets the operator tune it without a code redeploy). Format: one pattern per line
 * (commas also separate); a line wrapped in /slashes/ is a case-insensitive regex,
 * anything else is a case-insensitive substring. Blank lines and lines starting with
 * `#` are ignored.
 *
 * PERMISSIVE WHEN UNCONFIGURED (returns ok) — over-blocking legal speech is against the
 * ethos, and a text filter can't be comprehensive anyway. Configuring CONTENT_DENYLIST
 * is an operator "before public launch" gate item; an empty list warns once.
 */

export interface ScreenResult {
  ok: boolean;
  /** Category for logs/telemetry — NOT shown verbatim to the user. */
  reason?: "denylisted";
}

type Pattern = { kind: "regex"; re: RegExp } | { kind: "substring"; text: string };

/** Parse a raw CONTENT_DENYLIST string into matchable patterns. Pure + testable. */
export function parseDenylist(raw: string | undefined): Pattern[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line): Pattern | null => {
      if (line.length >= 2 && line.startsWith("/") && line.endsWith("/")) {
        try {
          return { kind: "regex", re: new RegExp(line.slice(1, -1), "i") };
        } catch {
          // Malformed regex → skip it rather than brick the whole filter.
          console.warn(`[OpenBook] CONTENT_DENYLIST: skipping malformed regex pattern: ${line}`);
          return null;
        }
      }
      return { kind: "substring", text: line.toLowerCase() };
    })
    .filter((p): p is Pattern => p !== null);
}

let _warnedUnconfigured = false;

/**
 * Screen post content against the configured denylist.
 * @param content       the (trimmed) post content about to be persisted + broadcast
 * @param denylistRaw   override for testing; defaults to process.env.CONTENT_DENYLIST
 */
export function screenContent(
  content: string,
  denylistRaw: string | undefined = process.env.CONTENT_DENYLIST
): ScreenResult {
  const patterns = parseDenylist(denylistRaw);

  if (patterns.length === 0) {
    if (!_warnedUnconfigured) {
      _warnedUnconfigured = true;
      console.warn(
        "[OpenBook] CONTENT_DENYLIST is not configured — the pre-publish content screen is a no-op. Set it before public launch (illegal-floor patterns)."
      );
    }
    return { ok: true };
  }

  const haystack = content.toLowerCase();
  for (const p of patterns) {
    const hit = p.kind === "substring" ? haystack.includes(p.text) : p.re.test(content);
    if (hit) return { ok: false, reason: "denylisted" };
  }
  return { ok: true };
}
