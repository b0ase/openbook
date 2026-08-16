import { db } from "./db";
import { canonicalTicker, isValidTicker } from "./ticker";
import { canAfford, DERIVE_COST_SATS, tryDebitTicker } from "./ticker-budget";

/**
 * An agent tending the meaning of its own word.
 *
 * ⚠ IT OBSERVES, IT DOES NOT DECIDE. An agent cannot anticipate how people will
 * adopt its word — nobody can — but it can read what they have actually done
 * with it and report back. So this never writes a definition from the agent's
 * own opinion: it summarises usage. If the corpus says `$pink` has become a
 * argument about branding, the meaning says that, however the word started.
 *
 * ⚠ NOT A POST, AND THIS IS THE WHOLE POINT. A post mints a token and is
 * inscribed. An auto-written definition as a post would quietly mint a unit of
 * every word to whoever ran the job, and would freeze permanently the one thing
 * that must stay revisable. Meaning moves; `cloud` was not settled in 2005. See
 * TOKENS.md "A keyword is a living definition, and the agent maintains it".
 */

/** Below this the corpus is too thin to say anything a reader could not see. */
const MIN_CORPUS = 3;
/**
 * Re-derive once the corpus has grown by this much.
 *
 * Growth, not elapsed time: a word nobody used has not changed, and re-deriving
 * it costs an API call to restate the same thing.
 */
const REDERIVE_GROWTH = 3;
/** How much of the corpus the model reads. Newest, since drift is recent. */
const CORPUS_SAMPLE = 40;
/**
 * How many stale words to consider before giving up for this tick.
 *
 * Bounded so an unaffordable backlog cannot turn one tick into a long scan. If
 * the top N stalest words are all broke, deriving nothing this beat is right —
 * they will still be stale next beat, and by then they may have earned.
 */
const STALE_CANDIDATES = 20;
const MAX_MEANING_CHARS = 400;

export interface TickerMeaning {
  symbol: string;
  meaning: string | null;
  corpusSize: number;
  updatedAt: string;
  /** What the word means in the world, before this board touched it. */
  anchor?: string | null;
  anchorUrl?: string | null;
}

/**
 * The word's meaning in the world, fetched once from Wikipedia.
 *
 * ⚠ THIS IS A PRIOR, NOT A DEFINITION THIS BOARD OWNS. It is what stops a
 * keyword being defined by whatever happened to be said in it first: `$pink`
 * whose only post is a post ABOUT dilution would otherwise come to mean
 * dilution. The anchor holds the colour; the board accretes on top of it.
 *
 * ⚠ WIKIPEDIA, NOT A DICTIONARY. Cambridge and friends are copyrighted, and
 * anything stored here could end up displayed or inscribed. Wikipedia is
 * CC BY-SA, so it is usable with attribution — which is why `anchor_url` is
 * stored alongside and always shown.
 *
 * Fetched ONCE per word and never re-fetched: the anchor is the fixed point.
 * Words with no article (`$B0ase`, `$Memeplex`) simply have none, and the UI
 * shows nothing rather than something wrong.
 */
export async function fetchAnchor(symbol: string): Promise<{ text: string; url: string } | null> {
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return null;
  // Title-case: Wikipedia titles are case-sensitive after the first letter, and
  // an all-caps title misses almost everything.
  const title = canonical.charAt(0) + canonical.slice(1).toLowerCase();
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      type?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    // Disambiguation pages describe the ambiguity, not the word — worse than
    // nothing, because they read as a definition.
    if (data.type === "disambiguation") return null;
    const text = (data.extract ?? "").trim();
    if (text.length < 20) return null;
    return {
      text: text.length > 500 ? `${text.slice(0, 499).trimEnd()}…` : text,
      url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
    };
  } catch {
    return null;
  }
}

/** Fetch and store the anchor if this word has never had one. Safe to call often. */
export async function ensureAnchor(symbol: string): Promise<void> {
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return;
  try {
    const row = db.prepare("SELECT anchor FROM ticker_meanings WHERE symbol = ?").get(canonical) as
      | { anchor: string | null }
      | undefined;
    if (row?.anchor) return;
    const found = await fetchAnchor(canonical);
    if (!found) return;
    db.prepare(
      `INSERT INTO ticker_meanings (symbol, meaning, corpus_size, anchor, anchor_url)
       VALUES (?, NULL, 0, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET anchor = excluded.anchor, anchor_url = excluded.anchor_url`
    ).run(canonical, found.text, found.url);
  } catch {
    /* An absent anchor is a missing nicety, never a failure. */
  }
}

export function getTickerMeaning(symbol: string): TickerMeaning | null {
  const canonical = canonicalTicker(String(symbol).trim().replace(/^\$+/, ""));
  if (!isValidTicker(canonical)) return null;
  const row = db
    .prepare(
      "SELECT symbol, meaning, corpus_size, updated_at, anchor, anchor_url FROM ticker_meanings WHERE symbol = ?"
    )
    .get(canonical) as
    | {
        symbol: string;
        meaning: string | null;
        corpus_size: number;
        updated_at: string;
        anchor: string | null;
        anchor_url: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol,
    meaning: row.meaning,
    corpusSize: row.corpus_size,
    updatedAt: row.updated_at,
    anchor: row.anchor,
    anchorUrl: row.anchor_url,
  };
}

/** Every post that has used this word, newest first. This is the corpus. */
function corpusFor(symbol: string): string[] {
  const rows = db
    .prepare(
      `SELECT p.content
         FROM ticker_mentions m
         JOIN posts p ON p.id = m.post_id
        WHERE m.symbol = ?
        ORDER BY p.id DESC
        LIMIT ?`
    )
    .all(symbol, CORPUS_SAMPLE) as Array<{ content: string }>;
  return rows.map((r) => r.content).filter(Boolean);
}

function corpusSize(symbol: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticker_mentions WHERE symbol = ?")
    .get(symbol) as { n: number };
  return row?.n ?? 0;
}

/**
 * The word whose meaning is most worth re-reading right now, or null.
 *
 * One per tick, deliberately: this is an API call per word, and a job that
 * re-derives everything on every beat would spend real money restating things
 * nobody has touched.
 *
 * ⚠ CANDIDATES ARE FILTERED BY WHAT THEY CAN AFFORD. Staleness alone used to
 * decide this, which made the derivation bill a function of the tick rate rather
 * than of demand — the one unfunded line in the agent design. A word that cannot
 * pay is skipped and the NEXT stale word is considered, so a single broke-but-busy
 * word cannot block every other word behind it.
 *
 * The affordability check is a read; the money is taken in `deriveTickerMeaning`
 * immediately before the call. Two ticks racing here both see "affordable" and
 * one of them loses the atomic debit, which is the correct outcome.
 */
export function nextStaleTicker(): string | null {
  const rows = db
    .prepare(
      `SELECT m.symbol AS symbol, COUNT(*) AS n,
              COALESCE(tm.corpus_size, 0) AS was
         FROM ticker_mentions m
         LEFT JOIN ticker_meanings tm ON tm.symbol = m.symbol
        GROUP BY m.symbol
       HAVING n >= ? AND n - was >= ?
        ORDER BY (n - was) DESC
        LIMIT ?`
    )
    .all(MIN_CORPUS, REDERIVE_GROWTH, STALE_CANDIDATES) as Array<{ symbol: string }>;

  for (const row of rows) {
    if (canAfford(row.symbol, DERIVE_COST_SATS)) return row.symbol;
  }
  return null;
}

/**
 * Read how a word is being used and write down what it has come to mean.
 *
 * Returns the new meaning, or null if there was nothing worth saying. Never
 * throws: a failed derivation must not take down the tick that called it.
 */
export async function deriveTickerMeaning(symbol: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const canonical = canonicalTicker(symbol);
  if (!isValidTicker(canonical)) return null;

  const corpus = corpusFor(canonical);
  if (corpus.length < MIN_CORPUS) return null;

  // ⚠ THE WORD PAYS BEFORE THE CALL IS MADE, and is not refunded if it fails.
  // Same ordering as free-boot grants (DECISIONS.md "consume the grant BEFORE
  // paying"): a crash between debit and spend must lose the budget, never
  // double-spend it. A model call that errors after being issued may still have
  // been billed, so refunding on failure would let a flapping upstream drain
  // real money while the ledger showed none spent.
  //
  // Checked last, after the cheap rejections above, so a word is never charged
  // for a derivation that was never going to happen.
  if (!tryDebitTicker(canonical, DERIVE_COST_SATS)) return null;

  const anchorRow = db
    .prepare("SELECT anchor FROM ticker_meanings WHERE symbol = ?")
    .get(canonical) as { anchor: string | null } | undefined;

  const system = [
    `You maintain the definition of the word "$${canonical}" on a public board.`,
    anchorRow?.anchor
      ? [
          "",
          "What the word means in the world (the starting point, not the answer):",
          anchorRow.anchor,
          "",
          "⚠ This is the ANCHOR. A thread whose few posts happen to be ABOUT the",
          "word rather than USING it must not be allowed to redefine it — a $pink",
          "containing one post about dilution still means the colour. Depart from",
          "the anchor only where usage genuinely and repeatedly departs from it,",
          "and say so when it does.",
        ].join("\n")
      : "",
    "",
    "You are not deciding what it means. You are reporting what the people using",
    "it have made it mean. Read the posts below — every one of them used this",
    "word — and write its CURRENT working definition on this board.",
    "",
    "Rules:",
    "- One or two sentences. A definition, not a summary of the posts.",
    "- Describe the sense people actually use, even if it has drifted from the",
    "  dictionary. Drift is the thing worth recording.",
    "- If usage is genuinely split between senses, say so in one clause rather",
    "  than picking a winner.",
    "- If the posts are too thin or too scattered to support a definition, reply",
    "  with exactly: INSUFFICIENT",
    "- No preamble. No quoting. Do not mention posts, threads or this board.",
  ].join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system,
        messages: [
          {
            role: "user",
            content: `Posts using $${canonical}, newest first:\n\n${corpus
              .map((c) => `- ${c.slice(0, 400)}`)
              .join("\n")}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    // The model's own admission that the corpus cannot support a definition. An
    // honest absence is better than a confident invention nobody can correct.
    if (!text || text.toUpperCase().startsWith("INSUFFICIENT")) return null;

    const meaning =
      text.length > MAX_MEANING_CHARS ? `${text.slice(0, MAX_MEANING_CHARS - 1).trimEnd()}…` : text;

    db.prepare(
      `INSERT INTO ticker_meanings (symbol, meaning, corpus_size, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET
         meaning = excluded.meaning,
         corpus_size = excluded.corpus_size,
         updated_at = excluded.updated_at`
    ).run(canonical, meaning, corpusSize(canonical));

    return meaning;
  } catch {
    return null;
  }
}
