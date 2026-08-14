import path from "node:path";
import Database from "better-sqlite3";

let db: ReturnType<typeof Database>;

type Db = ReturnType<typeof Database>;

/**
 * ALTER TABLE ADD COLUMN is NOT idempotent, and `next build` collects page data
 * across many parallel worker processes that each import this module and run these
 * migrations against the SAME database file. On a FRESH db they race — two workers
 * both see a column missing and both ADD it → "duplicate column name" (this broke
 * the Railway build on a fresh /data). Guard each add so a lost race is a harmless
 * no-op; the column ends up present either way.
 *
 * Returns true only if THIS caller added the column.
 */
export function addColumnIfMissing(
  database: Db,
  table: string,
  column: string,
  definition: string
): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    return true;
  } catch (err) {
    // Another process won the race and added it first — the column now exists,
    // which is exactly what we wanted. Re-throw anything that ISN'T that.
    if (err instanceof Error && /duplicate column name/i.test(err.message)) return false;
    throw err;
  }
}

/**
 * Threading columns + backfill (see THREADS.md).
 *
 * Exported and parameterised on `database` SO IT CAN BE TESTED AGAINST A REAL
 * PRE-THREADING SCHEMA. The backfill's whole job is to convert rows that already
 * exist, and the live DB is migrated at import — so a test that only inspects the
 * live DB can never observe the conversion happening. Calling this against a
 * hand-built old-schema database is the only way to prove it works.
 *
 * Idempotent: safe to call repeatedly.
 */
export function applyThreadingMigration(database: Db): void {
  // posts.parent_id — the reply's immediate parent. NULL = this post is a thread
  // root, which is what the feed shows and what a token ticker attaches to.
  addColumnIfMissing(database, "posts", "parent_id", "parent_id INTEGER REFERENCES posts(id)");
  // posts.root_id — the thread this post belongs to, denormalised so a thread's
  // contents are `WHERE root_id = ?`: ONE indexed scan, not a WITH RECURSIVE walk.
  // That query sits on the token-allocation path (per mint, per payout), which is
  // why the root is stored rather than derived.
  addColumnIfMissing(database, "posts", "root_id", "root_id INTEGER REFERENCES posts(id)");

  // Backfill: every pre-threading post (the genesis seed + all pre-launch posts)
  // is a thread root, so its root is itself. Run unconditionally rather than only
  // when the column was just added — a crash between the ADD COLUMN and this
  // UPDATE would otherwise leave rows permanently unrooted, and the predicate
  // makes a repeat run a no-op.
  //
  // ⚠ WITHOUT THIS, `root_id IS NULL` means "self-rooted" and EVERY thread query
  // needs `WHERE root_id = ? OR (id = ? AND root_id IS NULL)` forever. One
  // statement here removes that footgun from every future caller.
  database.exec("UPDATE posts SET root_id = id WHERE root_id IS NULL AND parent_id IS NULL");

  // `root_id` serves thread reads and token allocation; `parent_id` serves both
  // direct-reply lookup AND the root feed.
  database.exec("CREATE INDEX IF NOT EXISTS idx_posts_root_id ON posts(root_id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_posts_parent_id ON posts(parent_id)");

  // ⚠ NO PARTIAL INDEX HERE, AND THAT IS A MEASURED DECISION. THREADS.md specced
  // `idx_posts_roots ON posts(id DESC) WHERE parent_id IS NULL` for the root feed.
  // EXPLAIN QUERY PLAN on 50 roots + 2,000 replies says it is redundant: SQLite
  // picks `idx_posts_parent_id` and never considers it. The reason is that `id` is
  // INTEGER PRIMARY KEY, i.e. the rowid — so an index on (parent_id) stores
  // (parent_id, rowid) and walking its `parent_id IS NULL` span backwards already
  // yields `ORDER BY id DESC` with NO sort step. The partial index would only add
  // write cost on every insert. Re-measure before adding one back.
}

try {
  db = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), "local.db"));
} catch (err) {
  throw new Error(
    `OpenCook DB: failed to open local.db — ${err instanceof Error ? err.message : String(err)}`
  );
}

try {
  // Concurrency guard for `next build`: it collects page data across ~31 worker
  // processes that each import this module and run schema init against the SAME
  // fresh DB file. Without this, two writers collide → "database is locked".
  // busy_timeout makes a blocked writer WAIT (up to 10s) for the lock instead of
  // throwing immediately, so the parallel inits serialize cleanly. Set FIRST, so
  // even the journal_mode/DDL writes below honor it. (Runtime is single-process,
  // so this is effectively a no-op there.)
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      author_name TEXT NOT NULL,
      signature TEXT,
      pubkey TEXT,
      tx_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bootboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      boosted_by TEXT NOT NULL,
      booted_at TEXT NOT NULL DEFAULT (datetime('now')),
      held_until TEXT,
      FOREIGN KEY (post_id) REFERENCES posts(id)
    )
  `);

  // bootboard.boosted_by_name — display name (anon_XXXX); boosted_by holds the
  // BSV address (stable ID for queries). Back-fill copies the old display name.
  if (addColumnIfMissing(db, "bootboard", "boosted_by_name", "boosted_by_name TEXT")) {
    db.exec("UPDATE bootboard SET boosted_by_name = boosted_by WHERE boosted_by_name IS NULL");
  }
  // bootboard.is_free — 1 = server-funded free boot, 0 = user-paid. Existing rows
  // pre-date this column; the DEFAULT 0 treats them as paid (conservative).
  addColumnIfMissing(db, "bootboard", "is_free", "is_free INTEGER NOT NULL DEFAULT 0");

  // posts.signature / posts.pubkey — added after the original posts schema.
  addColumnIfMissing(db, "posts", "signature", "signature TEXT");
  addColumnIfMissing(db, "posts", "pubkey", "pubkey TEXT");

  // Threading columns, backfill and indexes — see THREADS.md. Extracted so the
  // backfill can be tested against a real pre-threading schema.
  applyThreadingMigration(db);

  // Boot grants — free boot tracking per user (no custody)
  db.exec(`
    CREATE TABLE IF NOT EXISTS boot_grants (
      pubkey TEXT PRIMARY KEY,
      free_boots_used INTEGER NOT NULL DEFAULT 0,
      total_boots INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Payout records — audit trail only, no balances held
  db.exec(`
    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boot_event_id INTEGER NOT NULL,
      recipient_pubkey TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      payout_type TEXT NOT NULL,
      txid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Indexes for query performance
  db.exec("CREATE INDEX IF NOT EXISTS idx_bootboard_post_id ON bootboard(post_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_bootboard_held_until ON bootboard(held_until)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_posts_pubkey ON posts(pubkey)");
  // Threading indexes live in applyThreadingMigration() above, beside the columns
  // they serve — so a test that runs the migration gets the indexes too.
  db.exec("CREATE INDEX IF NOT EXISTS idx_payouts_boot ON payouts(boot_event_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payouts_recipient ON payouts(recipient_pubkey)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payouts_address ON payouts(recipient_address)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_txid ON payouts(txid, recipient_address)");
} catch (err) {
  throw new Error(
    `OpenCook DB: failed during schema init — ${err instanceof Error ? err.message : String(err)}`
  );
}

export { db };
