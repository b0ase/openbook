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

/**
 * Split a raw denylist into pattern tokens, WITHOUT cutting regexes in half.
 *
 * ⚠ THIS USED TO BE `raw.split(/[\n,]/)` AND IT SILENTLY DISARMED PATTERNS. A
 * comma is a separator, and a comma is also how you write a regex quantifier — so
 * `/\d{2,4}-scam/` was split into `/\d{2` and `4}-scam/`. Neither starts AND ends
 * with a slash, so neither was treated as a regex; both became substring rules
 * that match nothing. **No warning fired**, because nothing was malformed — the
 * pieces were perfectly good substrings. A safety control quietly became a no-op,
 * which is the worst way for one to fail.
 *
 * So separators are recognised only OUTSIDE a `/…/` region. A token that opens
 * with a slash scans to the next unescaped slash; if what follows is a separator
 * or the end, it is a regex and any commas inside it were literal.
 *
 * ⚠ AND IT STAYS A SUBSTRING OTHERWISE, which is what preserves the old
 * behaviour for things like `/path/to/thing` — a leading slash does not make
 * something a regex, matching-slashes-with-nothing-after does. That is exactly
 * the rule the previous code applied; this only stops commas breaking it first.
 */
export function splitPatterns(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const isSep = (c: string) => c === "," || c === "\n";

  while (i < raw.length) {
    while (i < raw.length && (isSep(raw[i]) || raw[i] === "\r")) i++;
    if (i >= raw.length) break;

    const start = i;
    let end = -1;

    // Leading slash (after any indent) — try to read a whole regex.
    let probe = i;
    while (probe < raw.length && (raw[probe] === " " || raw[probe] === "\t")) probe++;
    if (raw[probe] === "/") {
      let j = probe + 1;
      while (j < raw.length) {
        if (raw[j] === "\\") {
          j += 2; // an escaped character, including \/ — never closes the regex
          continue;
        }
        if (raw[j] === "/") break;
        if (raw[j] === "\n") break; // a regex cannot span lines
        j++;
      }
      if (raw[j] === "/") {
        let after = j + 1;
        while (after < raw.length && (raw[after] === " " || raw[after] === "\t")) after++;
        // Only a regex if nothing but a separator follows it.
        if (after >= raw.length || isSep(raw[after]) || raw[after] === "\r") end = j + 1;
      }
    }

    if (end === -1) {
      // Ordinary token: runs to the next separator, commas included.
      end = start;
      while (end < raw.length && !isSep(raw[end])) end++;
    }

    const token = raw.slice(start, end).trim();
    if (token) out.push(token);
    i = end;
  }
  return out;
}

/** Parse a raw CONTENT_DENYLIST string into matchable patterns. Pure + testable. */
export function parseDenylist(raw: string | undefined): Pattern[] {
  if (!raw) return [];
  return splitPatterns(raw)
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
        "[OpenBooks] CONTENT_DENYLIST is not configured — the pre-publish content screen is a no-op. Set it before public launch (illegal-floor patterns)."
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
