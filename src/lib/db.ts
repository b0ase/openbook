import path from "node:path";
import Database from "better-sqlite3";
import { distinctTickers, isRootTicker, ROOT_TICKER } from "./ticker";

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

/**
 * Link previews (see the unfurl service). One row per distinct URL, keyed by a
 * hash of the normalised URL, so a link shared by a hundred posts is fetched once.
 *
 * `posts.preview_hash` points at it. Nullable, because most posts have no link
 * and because unfurling is fire-and-forget — a post exists before its preview does.
 *
 * ⚠ FAILURES ARE ROWS TOO. A blocked or dead URL is stored with a non-'ok' status
 * rather than left absent, so a hostile link is fetched ONCE and then answered from
 * the table. Without that, every post of a bad URL is a fresh outbound request.
 *
 * Exported and parameterised for the same reason as applyThreadingMigration:
 * so it can be tested against a schema that predates it.
 */
/**
 * Ticker registry — `$Ticker` → the thread it names.
 *
 * ⚠ FIRST CLAIM WINS, AND THE DATABASE IS WHAT ENFORCES IT. `symbol` is the
 * PRIMARY KEY, so registration is `INSERT OR IGNORE` and the second claimant
 * silently loses. That is deliberate: BSV-21 identity is the deploy `txid_vout`,
 * so `sym` is NOT globally unique at the protocol level (TOKENS.md,
 * "BSV-20 vs BSV-21"). The protocol therefore cannot tell two `$NewIdea` threads
 * apart — but a `$ticker` written in a post has to resolve to exactly ONE thread
 * or the link is ambiguous, so the APP supplies the uniqueness the protocol
 * deliberately does not.
 *
 * Symbols are stored CANONICAL (uppercase, no `$`) — see `lib/ticker.ts`. A
 * case-sensitive key would let someone claim a visually identical name, which is
 * exactly the impersonation attack the BSV-21 notes warn about.
 *
 * `root_id` rather than `post_id` is what a reader wants: the ticker names a
 * THREAD, and the claiming post is just where it was first said.
 */
/**
 * `nyms` — which ticker an identity has adopted as its public name.
 *
 * ⚠ A NYM IS AN ORDINARY TICKER CLAIM, and this table only records WHICH of an
 * identity's claims is the one it goes by. Keeping it separate is what stops a
 * nym from being a privileged kind of name: `$Harry` is claimed by posting, obeys
 * first-claim-wins through the same PRIMARY KEY as every other symbol, and can be
 * cited and minted into like any other. If nyms lived in their own namespace they
 * would need their own uniqueness rule, their own squatting story, and their own
 * parse rule — three more things to keep in step with `ticker.ts`.
 *
 * `pubkey` is the primary key: one identity, one public name at a time, and
 * adopting a different one is an UPDATE rather than an accumulation. `symbol` is
 * UNIQUE so two identities cannot both go by `$Harry` — which the tickers table
 * already prevents at claim time, but this makes it true of the display name
 * independently, since a symbol can change hands later.
 */
export function applyNymMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS nyms (
      pubkey     TEXT PRIMARY KEY,
      symbol     TEXT NOT NULL UNIQUE,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_nyms_symbol ON nyms(symbol)");
}

/**
 * `reserved_tickers` — names an ordinary post cannot claim.
 *
 * ⚠ THIS IS INSURANCE, NOT CENSORSHIP, AND THE DIFFERENCE IS THE RELEASE PATH.
 * Claiming the common vocabulary costs roughly $2 once inscription exists
 * (DIRECTION.md), so the entire English language can be cornered by whoever runs
 * a script first — and the moment the index is published, doing so becomes
 * obviously worth it. Reserving costs nothing, is reversible, and holds the
 * namespace open until the platform can mint properly.
 *
 * ⚠ A TABLE, NOT A HARDCODED LIST. The operator has to be able to release a name
 * — one at a time, or all of them — WITHOUT a deploy. A constant in the source
 * would mean every release is a code change, which is how a temporary measure
 * becomes permanent by friction.
 *
 * ⚠ IT NEVER TOUCHES AN EXISTING CLAIM. Reserving is checked only at claim time
 * (`registerTickers`), so a name somebody already holds stays theirs whatever
 * this table says. Anything else would be retroactively confiscating a name that
 * was claimed under the rules as they stood.
 *
 * `reason` is stored so a refusal can explain itself, and so a later reader can
 * tell a landgrab reservation from any other kind.
 */
export function applyReservedTickerMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reserved_tickers (
      symbol      TEXT PRIMARY KEY,
      reason      TEXT NOT NULL DEFAULT 'namespace',
      reserved_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * The mention edge — `(from_post, ticker, target)`, the shape settled in
 * TOKENS.md *"Tagging: a tag is a MENTION WITH A TARGET"*.
 *
 * ⚠ THE TARGET COLUMNS ARE THE POINT, and they are built before the feature
 * that uses them. A tag is not a fourth primitive: an inline `$TICKER` in prose
 * is the `target_type = 'none'` case, tagging a post is `'post'`, and tagging a
 * ticker (`$MEMEPLEX ($PRETENTIOUS)`) is `'ticker'`. Adding the discriminator
 * now is one table; retrofitting a second target type onto a populated edge
 * table later is a migration over live data.
 *
 * ⚠ TAGGING ITSELF STAYS GATED ON PAID POSTING. This is schema only — nothing
 * writes a targeted row yet. Free tags would put `$COOL` on everything within a
 * day and the units could never be recalled (*anything free that confers value
 * destroys the anchor*).
 *
 * Replaces a `LIKE '%$SYM%'` scan of post content that was **silently capped at
 * 500 rows**, so a widely-named ticker's supply was wrong — and supply is what
 * ranks the public index.
 *
 * ONE UNIT PER POST PER TARGET, enforced by partial unique indexes rather than a
 * table-level UNIQUE: SQLite treats NULLs as distinct, so a plain
 * `UNIQUE(post_id, symbol, target_post_id, target_symbol)` would NOT dedupe the
 * untargeted rows — writing `$branch $branch` in one post would count twice, and
 * counting repetition lets anyone inflate a figure readers treat as significance
 * just by typing.
 */
export function applyTickerMentionMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_mentions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol         TEXT NOT NULL,
      -- ON DELETE CASCADE on BOTH post references: an edge is meaningless
      -- without the post that made it or the post it points AT. Production
      -- never deletes a post (permanence is the product), so this is inert
      -- there — it exists so the edge table can never hold dangling rows.
      post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      pubkey         TEXT,
      target_type    TEXT NOT NULL DEFAULT 'none'
                       CHECK (target_type IN ('none', 'post', 'ticker')),
      target_post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      target_symbol  TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (target_type = 'none'   AND target_post_id IS NULL     AND target_symbol IS NULL) OR
        (target_type = 'post'   AND target_post_id IS NOT NULL AND target_symbol IS NULL) OR
        (target_type = 'ticker' AND target_post_id IS NULL     AND target_symbol IS NOT NULL)
      )
    )
  `);

  // One unit per post per target — see the note above on why these are partial
  // indexes and not a table-level UNIQUE.
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_uniq_none
                   ON ticker_mentions(post_id, symbol) WHERE target_type = 'none'`);
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_uniq_post
                   ON ticker_mentions(post_id, symbol, target_post_id) WHERE target_type = 'post'`);
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_uniq_ticker
                   ON ticker_mentions(post_id, symbol, target_symbol) WHERE target_type = 'ticker'`);

  // Supply ("how many posts named this") is the hot read — it ranks /tickers.
  database.exec("CREATE INDEX IF NOT EXISTS idx_mentions_symbol ON ticker_mentions(symbol)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_mentions_post ON ticker_mentions(post_id)");
  // "Which tags does this post carry" — the read the tag UI will need.
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_mentions_target_post ON ticker_mentions(target_post_id)"
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_mentions_target_symbol ON ticker_mentions(target_symbol)"
  );

  backfillTickerMentions(database);
}

/**
 * One-time backfill of untargeted mentions from existing post content.
 *
 * ⚠ Guarded on the table being EMPTY, not on a per-post check. `createPost`
 * records mentions going forward, so this only ever needs to run once — and the
 * degenerate case it re-runs on (a board where no post has ever named a ticker)
 * is a scan of a board with no tickers in it, which costs nothing.
 *
 * Parsed with `distinctTickers`, the SAME rule the renderer and the registry
 * use. Deriving mentions from a second pattern here is precisely how the stored
 * edges would drift from what readers see and from what gets CLAIMED.
 */
export function backfillTickerMentions(database: Db): void {
  const existing = database.prepare("SELECT 1 FROM ticker_mentions LIMIT 1").get();
  if (existing) return;

  const posts = database.prepare("SELECT id, content, pubkey FROM posts").all() as {
    id: number;
    content: string;
    pubkey: string | null;
  }[];
  if (!posts.length) return;

  const insert = database.prepare(
    `INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, pubkey, target_type)
     VALUES (?, ?, ?, 'none')`
  );
  const run = database.transaction(() => {
    for (const p of posts) {
      for (const symbol of distinctTickers(p.content)) {
        insert.run(symbol, p.id, p.pubkey);
      }
    }
  });
  run();
}

export function applyTickerMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tickers (
      symbol     TEXT PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES posts(id),
      root_id    INTEGER NOT NULL REFERENCES posts(id),
      pubkey     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // tickers.parent_symbol — the ticker of the thread the claim was MADE IN, which
  // is what makes the tree in TOKENS.md real rather than notional: a token branches
  // from the token it was named inside, and a parent takes a share of each child.
  //
  // The root token has parent NULL and is its own top. Everything claimed in the
  // main feed (a thread with no ticker of its own) parents to the root, so the
  // whole board reads as one tree: $OPENBOOK / $CHILD / $GRANDCHILD.
  addColumnIfMissing(database, "tickers", "parent_symbol", "parent_symbol TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_tickers_parent ON tickers(parent_symbol)");

  // Reverse lookup: "which tickers does this thread carry?" — used to show a
  // thread's own symbol, and by any future allocation that keys on the thread.
  database.exec("CREATE INDEX IF NOT EXISTS idx_tickers_root_id ON tickers(root_id)");

  repairTickerParents(database);
}

/**
 * Recompute every ticker's parent from the POST PARENT CHAIN.
 *
 * ⚠ DERIVED FROM `parent_id`, NEVER FROM `root_id`. An earlier version of this
 * inferred the parent as "another ticker sharing my root_id" and produced
 * `$branch/$test` — the tree upside down — because it never required the parent
 * to have been claimed EARLIER. It is also unusable after a ticker claim re-roots
 * its post (see `registerTickers`), since each ticker then owns its own root and
 * no two tickers share one. The post parent chain survives both: it records who
 * was replying to whom, which is exactly what "branches from" means.
 *
 * Recomputed in full on every boot rather than patched. It is a handful of rows,
 * it is deterministic, and it self-heals a bad parent written by any earlier
 * version instead of leaving it stuck (a `WHERE parent_symbol IS NULL` guard
 * cannot repair a row that is wrong rather than missing).
 */
function repairTickerParents(database: Db): void {
  try {
    const tickers = database
      .prepare("SELECT symbol, post_id, parent_symbol FROM tickers")
      .all() as { symbol: string; post_id: number; parent_symbol: string | null }[];
    if (!tickers.length) return;

    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    const claimedAtPost = new Map<number, string>();
    for (const t of tickers) {
      // If two tickers were claimed by the same post, the earlier symbol wins as
      // that post's identity — arbitrary but stable.
      const existing = claimedAtPost.get(t.post_id);
      if (!existing || t.symbol < existing) claimedAtPost.set(t.post_id, t.symbol);
    }

    const parentOf = database.prepare("SELECT parent_id FROM posts WHERE id = ?");
    const update = database.prepare("UPDATE tickers SET parent_symbol = ? WHERE symbol = ?");

    // ⚠ REPAIR root_id TOO, NOT JUST THE PARENT. Tickers claimed before the
    // re-root rule existed still carry the ENCLOSING thread's root, so clicking
    // them re-opens their parent — the exact bug the rule fixes, left frozen into
    // existing rows. Fixing only `parent_symbol` would give a correct-looking
    // path that still navigates to the wrong thread.
    //
    // A ticker claimed by a REPLY should own a thread rooted at that reply. Safe
    // and idempotent: it moves a post to root itself, never merges threads, and
    // re-running finds nothing left to change.
    const rerootPost = database.prepare(
      "UPDATE posts SET root_id = id WHERE id = ? AND root_id <> id"
    );
    const rerootTicker = database.prepare("UPDATE tickers SET root_id = ? WHERE symbol = ?");

    const run = database.transaction(() => {
      for (const t of tickers) {
        if (!isRootTicker(t.symbol)) {
          const post = parentOf.get(t.post_id) as { parent_id: number | null } | undefined;
          if (post?.parent_id != null) {
            rerootPost.run(t.post_id);
            rerootTicker.run(t.post_id, t.symbol);
          }
        }
        // Either spelling of the root parents to nothing. The board was
        // `$OpenBook` before it took the plural; an existing row under the old
        // name stays a root rather than becoming a child of its own successor.
        if (isRootTicker(t.symbol)) {
          if (t.parent_symbol !== null) update.run(null, t.symbol);
          continue;
        }
        // Walk up the reply chain until a post that claimed a different ticker.
        let cursor: number | null =
          (parentOf.get(t.post_id) as { parent_id: number | null } | undefined)?.parent_id ?? null;
        let found: string | null = null;
        for (let depth = 0; depth < 64 && cursor !== null; depth++) {
          const owner = claimedAtPost.get(cursor);
          if (owner && owner !== t.symbol) {
            found = owner;
            break;
          }
          cursor =
            (parentOf.get(cursor) as { parent_id: number | null } | undefined)?.parent_id ?? null;
        }
        // Nothing above it carries a ticker → it hangs off the root token, so the
        // whole board stays one tree.
        // ⚠ THIS LINE IS THE ROOT RENAME'S MIGRATION. Parents are recomputed
        // from scratch on every boot, so pointing the fallback at ROOT_TICKER
        // re-parents every top-level ticker from `OPENBOOK` to `OPENBOOKS` on
        // the next start — no migration script, no backfill, and it self-heals
        // if it is ever run against a half-renamed database.
        const parent = found ?? ROOT_TICKER;
        if (bySymbol.has(parent) || isRootTicker(parent)) {
          if (t.parent_symbol !== parent) update.run(parent, t.symbol);
        }
      }
    });
    run();
  } catch (err) {
    // Never block startup over a display-only tree. A wrong path is cosmetic; a
    // server that will not boot is not.
    console.error(
      `OpenBooks: ticker parent repair skipped — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function applyLinkPreviewMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS link_previews (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      status TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  addColumnIfMissing(
    database,
    "posts",
    "preview_hash",
    "preview_hash TEXT REFERENCES link_previews(url_hash)"
  );

  database.exec("CREATE INDEX IF NOT EXISTS idx_posts_preview_hash ON posts(preview_hash)");
  // Serves the re-fetch sweep: find stale or failed rows without scanning.
  database.exec("CREATE INDEX IF NOT EXISTS idx_link_previews_status ON link_previews(status)");
}

try {
  db = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), "local.db"));
} catch (err) {
  throw new Error(
    `OpenBooks DB: failed to open local.db — ${err instanceof Error ? err.message : String(err)}`
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

  // Link previews table + posts.preview_hash.
  applyLinkPreviewMigration(db);

  // Ticker registry — first claim wins.
  applyTickerMigration(db);
  // The mention edge — must come AFTER posts + tickers exist, since it
  // references posts(id) and backfills from post content.
  applyTickerMentionMigration(db);
  applyNymMigration(db);
  applyReservedTickerMigration(db);

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
    `OpenBooks DB: failed during schema init — ${err instanceof Error ? err.message : String(err)}`
  );
}

export { db };
