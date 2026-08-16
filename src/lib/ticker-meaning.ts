import { db } from "./db";
import { canonicalTicker, isValidTicker } from "./ticker";

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
const MAX_MEANING_CHARS = 400;

export interface TickerMeaning {
  symbol: string;
  meaning: string;
  corpusSize: number;
  updatedAt: string;
}

export function getTickerMeaning(symbol: string): TickerMeaning | null {
  const canonical = canonicalTicker(String(symbol).trim().replace(/^\$+/, ""));
  if (!isValidTicker(canonical)) return null;
  const row = db
    .prepare(
      "SELECT symbol, meaning, corpus_size, updated_at FROM ticker_meanings WHERE symbol = ?"
    )
    .get(canonical) as
    | { symbol: string; meaning: string; corpus_size: number; updated_at: string }
    | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol,
    meaning: row.meaning,
    corpusSize: row.corpus_size,
    updatedAt: row.updated_at,
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
 */
export function nextStaleTicker(): string | null {
  const row = db
    .prepare(
      `SELECT m.symbol AS symbol, COUNT(*) AS n,
              COALESCE(tm.corpus_size, 0) AS was
         FROM ticker_mentions m
         LEFT JOIN ticker_meanings tm ON tm.symbol = m.symbol
        GROUP BY m.symbol
       HAVING n >= ? AND n - was >= ?
        ORDER BY (n - was) DESC
        LIMIT 1`
    )
    .get(MIN_CORPUS, REDERIVE_GROWTH) as { symbol: string } | undefined;
  return row?.symbol ?? null;
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

  const system = [
    `You maintain the definition of the word "$${canonical}" on a public board.`,
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
