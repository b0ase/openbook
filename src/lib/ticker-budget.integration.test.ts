/**
 * A word paying for its own thinking, and the migration that unbroke anchors.
 *
 * Two halves, for the reason the other migration suites have two halves: the
 * `meaning` repair can only be SEEN against a schema that predates it, while the
 * budget ledger has to be exercised through the live singleton to prove it is
 * actually wired into schema init.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyTickerBudgetMigration, applyTickerMeaningMigration, db } from "./db";
import {
  canAfford,
  creditTicker,
  DERIVE_COST_SATS,
  FOUNDING_GRANT_SATS,
  getTickerBudget,
  tryDebitTicker,
} from "./ticker-budget";
import { nextStaleTicker } from "./ticker-meaning";

/** The schema as it shipped: `meaning` NOT NULL, which silently rejected anchors. */
function preMigrationDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE ticker_meanings (
      symbol      TEXT PRIMARY KEY,
      meaning     TEXT NOT NULL,
      corpus_size INTEGER NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      anchor      TEXT,
      anchor_url  TEXT
    )
  `);
  return database;
}

describe("ticker_meanings: meaning must be nullable", () => {
  it("rejected an anchor-only row before the migration — the bug", () => {
    const database = preMigrationDb();
    expect(() =>
      database
        .prepare(
          "INSERT INTO ticker_meanings (symbol, meaning, corpus_size, anchor) VALUES (?, NULL, 0, ?)"
        )
        .run("PINK", "a pale red colour")
    ).toThrow(/NOT NULL/i);
  });

  it("accepts an anchor with no meaning after the migration", () => {
    const database = preMigrationDb();
    applyTickerMeaningMigration(database);

    database
      .prepare(
        "INSERT INTO ticker_meanings (symbol, meaning, corpus_size, anchor) VALUES (?, NULL, 0, ?)"
      )
      .run("PINK", "a pale red colour");

    const row = database.prepare("SELECT * FROM ticker_meanings WHERE symbol = 'PINK'").get() as {
      meaning: string | null;
      anchor: string;
    };
    expect(row.meaning).toBeNull();
    expect(row.anchor).toBe("a pale red colour");
  });

  it("preserves existing rows through the table rebuild", () => {
    const database = preMigrationDb();
    database
      .prepare(
        "INSERT INTO ticker_meanings (symbol, meaning, corpus_size, anchor, anchor_url) VALUES (?,?,?,?,?)"
      )
      .run("OCCAM", "the simplest explanation", 12, "William of Ockham", "https://example.org");

    applyTickerMeaningMigration(database);

    const row = database.prepare("SELECT * FROM ticker_meanings WHERE symbol = 'OCCAM'").get() as {
      meaning: string;
      corpus_size: number;
      anchor_url: string;
    };
    expect(row.meaning).toBe("the simplest explanation");
    expect(row.corpus_size).toBe(12);
    expect(row.anchor_url).toBe("https://example.org");
  });

  it("is idempotent — running it twice changes nothing", () => {
    const database = preMigrationDb();
    applyTickerMeaningMigration(database);
    applyTickerMeaningMigration(database);
    database
      .prepare("INSERT INTO ticker_meanings (symbol, meaning, corpus_size) VALUES (?, NULL, 0)")
      .run("TWICE");
    expect(database.prepare("SELECT COUNT(*) AS n FROM ticker_meanings").get()).toEqual({ n: 1 });
  });

  it("leaves an already-nullable table alone", () => {
    const database = new Database(":memory:");
    applyTickerBudgetMigration(database);
    applyTickerMeaningMigration(database);
    applyTickerMeaningMigration(database);
    const cols = database.prepare("PRAGMA table_info(ticker_meanings)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(cols.find((c) => c.name === "meaning")?.notnull).toBe(0);
  });
});

describe("ticker budget", () => {
  beforeEach(() => {
    db.exec("DELETE FROM ticker_budgets");
    db.exec("DELETE FROM ticker_mentions");
    db.exec("DELETE FROM ticker_meanings");
    db.exec("DELETE FROM posts");
  });

  it("grants a new word exactly one derivation, once", () => {
    expect(canAfford("PINK", DERIVE_COST_SATS)).toBe(true);
    // Seeing it again must not top the grant up.
    canAfford("PINK", DERIVE_COST_SATS);
    canAfford("PINK", DERIVE_COST_SATS);
    expect(getTickerBudget("PINK")?.grantedSats).toBe(FOUNDING_GRANT_SATS);
    expect(getTickerBudget("PINK")?.balanceSats).toBe(FOUNDING_GRANT_SATS);
  });

  it("spends the grant once and then refuses", () => {
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS)).toBe(true);
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS)).toBe(false);
    expect(getTickerBudget("PINK")?.balanceSats).toBe(0);
    // The refused debit must not have been recorded as spend.
    expect(getTickerBudget("PINK")?.spentSats).toBe(DERIVE_COST_SATS);
  });

  it("a word that earns can think again", () => {
    tryDebitTicker("PINK", DERIVE_COST_SATS);
    expect(canAfford("PINK", DERIVE_COST_SATS)).toBe(false);

    creditTicker("PINK", DERIVE_COST_SATS * 2);

    expect(canAfford("PINK", DERIVE_COST_SATS)).toBe(true);
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS)).toBe(true);
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS)).toBe(true);
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS)).toBe(false);
  });

  it("never lets a balance go negative, whatever the debit", () => {
    expect(tryDebitTicker("PINK", DERIVE_COST_SATS * 100)).toBe(false);
    expect(getTickerBudget("PINK")?.balanceSats).toBe(FOUNDING_GRANT_SATS);
  });

  it("is case-insensitive — one word, one budget", () => {
    tryDebitTicker("pink", DERIVE_COST_SATS);
    expect(canAfford("$PINK", DERIVE_COST_SATS)).toBe(false);
    expect(canAfford("PiNk", DERIVE_COST_SATS)).toBe(false);
  });

  it("ignores symbols that are not tickers", () => {
    expect(tryDebitTicker("50", 1)).toBe(false);
    expect(getTickerBudget("50")).toBeNull();
    creditTicker("50", 1000);
    expect(getTickerBudget("50")).toBeNull();
  });
});

describe("nextStaleTicker only offers words that can pay", () => {
  beforeEach(() => {
    db.exec("DELETE FROM ticker_budgets");
    db.exec("DELETE FROM ticker_mentions");
    db.exec("DELETE FROM ticker_meanings");
    db.exec("DELETE FROM posts");
  });

  /** A word with enough corpus to be worth re-reading. */
  function seedCorpus(symbol: string, mentions: number) {
    const insertPost = db.prepare(
      "INSERT INTO posts (content, author_name, pubkey) VALUES (?, 'tester', 'pk')"
    );
    const insertMention = db.prepare(
      "INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, pubkey, target_type) VALUES (?,?,'pk','none')"
    );
    for (let i = 0; i < mentions; i++) {
      const { lastInsertRowid } = insertPost.run(`using $${symbol} number ${i}`);
      insertMention.run(symbol, Number(lastInsertRowid));
    }
  }

  it("offers a stale word that still has budget", () => {
    seedCorpus("PINK", 5);
    expect(nextStaleTicker()).toBe("PINK");
  });

  it("skips a broke word and offers the next stalest instead", () => {
    seedCorpus("PINK", 9); // stalest
    seedCorpus("OCCAM", 5);
    tryDebitTicker("PINK", DERIVE_COST_SATS); // PINK spends its grant

    expect(nextStaleTicker()).toBe("OCCAM");
  });

  it("returns null when every stale word is broke — the platform stops paying", () => {
    seedCorpus("PINK", 5);
    seedCorpus("OCCAM", 5);
    tryDebitTicker("PINK", DERIVE_COST_SATS);
    tryDebitTicker("OCCAM", DERIVE_COST_SATS);

    expect(nextStaleTicker()).toBeNull();
  });

  it("offers a broke word again once it has earned", () => {
    seedCorpus("PINK", 5);
    tryDebitTicker("PINK", DERIVE_COST_SATS);
    expect(nextStaleTicker()).toBeNull();

    creditTicker("PINK", DERIVE_COST_SATS);

    expect(nextStaleTicker()).toBe("PINK");
  });
});
