import path from "node:path";
import Database from "better-sqlite3";
import { distinctTickers, isRootTicker } from "./ticker";

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

  // nyms.address — the SAME identity, addressed the other way.
  //
  // ⚠ WITHOUT THIS THERE IS NO JOIN BETWEEN A SPENDER AND THEIR NAME. Posts
  // carry a `pubkey` and `nyms` is keyed on pubkey, so a post resolves its
  // author's name — but `bootboard.boosted_by` and `payouts.recipient_address`
  // are ADDRESSES, and an address cannot be turned back into a pubkey in SQL.
  // The result was one identity shown two ways on the same screen: `$B0ase` as
  // an author and `anon_xxxx` the moment they spent.
  //
  // ⚠ DERIVED SERVER-SIDE FROM THE VERIFIED PUBKEY, NEVER SUPPLIED BY THE
  // CLIENT. Accepting an address from the caller would let anyone display
  // somebody else's name as the spender on a boost they made.
  addColumnIfMissing(database, "nyms", "address", "address TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_nyms_address ON nyms(address)");
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

  // ⚠ `OPENBOOK` NAMES A DIFFERENT ASSET AND MUST NOT BE CLAIMABLE HERE. It was
  // the board's own pre-plural name until 2026-08-14, and is now the repository
  // token for github.com/b0ase/openbook — a fixed supply held by an issuer, not
  // one unit per post held by whoever wrote it. Letting somebody claim it on the
  // board would put the two one click apart under one string.
  //
  // Reserved at boot rather than by an operator call, because this is a
  // structural fact about the name rather than an operational choice, and a
  // reservation that depends on somebody remembering to run it is not one.
  // Reserved names are SKIPPED, never refused: writing `$OpenBook` in a post
  // still publishes, it simply claims nothing.
  database.exec(
    "INSERT OR IGNORE INTO reserved_tickers (symbol, reason) VALUES ('OPENBOOK', 'repo-token')"
  );
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
/**
 * What a `$Ticker` currently MEANS, as observed from how people use it.
 *
 * ⚠ DERIVED AND REVISABLE, NEVER A POST. A post would mint a token — so an
 * auto-written definition would quietly mint a unit of every word to whoever
 * ran the job — and it would be inscribed, i.e. permanent, which is the one
 * thing a meaning must not be. Words move. `cloud` was not settled in 2005.
 * See TOKENS.md "A keyword is a living definition".
 *
 * `corpus_size` is how many mentions the meaning was derived FROM. It is the
 * staleness check: re-derive when the corpus has grown enough to have plausibly
 * changed the word, not on a timer.
 */
export function applyTickerMeaningMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_meanings (
      symbol      TEXT PRIMARY KEY,
      meaning     TEXT,
      corpus_size INTEGER NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // The ANCHOR: what the word means in the world, before this board touched it.
  // Separate from `meaning` because they answer different questions — "what does
  // this word mean" vs "what has it come to mean here" — and because the anchor
  // is fetched once while the meaning is re-read as usage moves.
  addColumnIfMissing(database, "ticker_meanings", "anchor", "anchor TEXT");
  addColumnIfMissing(database, "ticker_meanings", "anchor_url", "anchor_url TEXT");
  relaxMeaningNotNull(database);
}

/**
 * ⚠ `meaning` MUST BE NULLABLE, AND ORIGINALLY WAS NOT. This silently broke anchors.
 *
 * A word gets its ANCHOR long before it has a derived MEANING — that is the
 * normal order, because the anchor is fetched the first time the word is seen
 * while the meaning needs a corpus to read. So `ensureAnchor` inserts a row with
 * `meaning = NULL`, which `meaning TEXT NOT NULL` rejected.
 *
 * The failure was invisible: that insert is wrapped in a best-effort catch (*"an
 * absent anchor is a missing nicety, never a failure"*), so the constraint error
 * was swallowed and **no anchor was ever stored for a word that had no meaning
 * yet** — i.e. for every word the anchor was built to serve. The feature looked
 * shipped and did nothing.
 *
 * SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt.
 * Idempotent: it inspects the column first and returns immediately once relaxed.
 * Runs AFTER the addColumnIfMissing calls above so the copy can name every column.
 */
function relaxMeaningNotNull(database: Db): void {
  const columns = database.prepare("PRAGMA table_info(ticker_meanings)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const meaning = columns.find((c) => c.name === "meaning");
  if (!meaning || meaning.notnull === 0) return;

  database.transaction(() => {
    database.exec(`
      CREATE TABLE ticker_meanings_rebuilt (
        symbol      TEXT PRIMARY KEY,
        meaning     TEXT,
        corpus_size INTEGER NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        anchor      TEXT,
        anchor_url  TEXT
      )
    `);
    database.exec(`
      INSERT INTO ticker_meanings_rebuilt (symbol, meaning, corpus_size, updated_at, anchor, anchor_url)
        SELECT symbol, meaning, corpus_size, updated_at, anchor, anchor_url FROM ticker_meanings
    `);
    database.exec("DROP TABLE ticker_meanings");
    database.exec("ALTER TABLE ticker_meanings_rebuilt RENAME TO ticker_meanings");
  })();
}

/**
 * What each word can afford to spend on thinking about itself.
 *
 * Three columns rather than one balance so the ledger stays auditable: what the
 * platform GAVE a word, what the word EARNED, and what it has SPENT. A single
 * mutable balance would make "how much has this cost us" unanswerable after the
 * fact, which is the question the whole mechanism exists to bound.
 *
 * See `lib/ticker-budget.ts` for why this is a ledger and not a wallet.
 */
/**
 * Who uploaded what, and what must never be stored again.
 *
 * ⚠ THIS EXISTS FOR ABUSE RESPONSE, NOT ANALYTICS. Uploads previously recorded
 * nothing at all: a content-addressed file appeared on disk with no time, no
 * origin, and no way to remove it. That is survivable for images of cats and not
 * survivable for a public board that accepts arbitrary bytes from anonymous
 * users. Without a row here you cannot answer a report, cannot find the same
 * uploader's other files, and cannot make a takedown stick.
 *
 * `original_name` is DISPLAY ONLY — it is what the download dialog offers, and
 * it never reaches a path. Stored names stay content hashes (see `upload.ts`).
 *
 * `ip_hash` rather than an IP: keyed with a server secret so it can group one
 * uploader's files without the database becoming a list of who read what. An
 * operator responding to a report needs "these twelve files came from one
 * source", which a hash answers, rather than an address, which it does not.
 *
 * `blocked_uploads` is keyed on the HASH, not the name, so a block survives
 * re-upload under any extension — the point of a takedown is that the file
 * cannot simply come back.
 */
/**
 * Addenda — corrections appended to a post, never edits of it.
 *
 * ⚠ A POST CANNOT BE EDITED, WHICH IS WHY THIS EXISTS. Every post is anchored
 * on-chain and carries a "View on chain" link, so rewriting the row would make
 * the site contradict the ledger in the one place a reader might check. The
 * board's whole claim is that what you wrote is yours and permanent; an editable
 * post quietly withdraws it.
 *
 * ⚠ AN ADDENDUM IS A POST, NOT A NEW KIND OF ROW. It is a reply flagged with this
 * column, so it inherits signing, paid posting, content screening and on-chain
 * anchoring with no second pipeline and no new money path. The flag only changes
 * how it is COUNTED and RENDERED: attached to its parent rather than listed as a
 * reply, and excluded from `reply_count` so a correction does not read as
 * somebody answering you.
 *
 * Who may append is enforced in `createPost`, not here: the signer's pubkey must
 * equal the parent's. A column cannot express that, and a client-supplied flag
 * must never be trusted to.
 */
export function applyAddendumMigration(database: Db): void {
  addColumnIfMissing(database, "posts", "is_addendum", "is_addendum INTEGER NOT NULL DEFAULT 0");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_posts_addendum ON posts(parent_id) WHERE is_addendum = 1"
  );
}

export function applyUploadAuditMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      name          TEXT PRIMARY KEY,
      sha256        TEXT NOT NULL,
      ext           TEXT NOT NULL,
      kind          TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      original_name TEXT,
      ip_hash       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_uploads_sha ON uploads(sha256)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_uploads_ip ON uploads(ip_hash)");
  database.exec(`
    CREATE TABLE IF NOT EXISTS blocked_uploads (
      sha256     TEXT PRIMARY KEY,
      reason     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function applyTickerBudgetMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_budgets (
      symbol       TEXT PRIMARY KEY,
      granted_sats INTEGER NOT NULL DEFAULT 0,
      earned_sats  INTEGER NOT NULL DEFAULT 0,
      spent_sats   INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Outpoints this server has already spent.
 *
 * ⚠ WITHOUT THIS THE AGENTS CANNOT POST TWICE. WhatsOnChain lists a CONFIRMED
 * output as unspent while the transaction spending it is still in the mempool,
 * so the next build selects it, produces a double-spend, and ARC rejects the lot
 * — observed live: `/api/unspent` returned both `4aa6731a…` (confirmed) and
 * `ac6c5b4d…` (height 0), the second being the change from spending the first.
 *
 * `client-boot.ts` has always blacklisted spent outpoints, but it persists to
 * localStorage — which does not exist on a server. The runtime therefore kept an
 * in-memory copy that every deploy erased, and an agent could post exactly once
 * per process. This is that blacklist, made durable for the server.
 *
 * Rows are disposable: losing one costs a rejected broadcast, not money. They
 * are pruned by age rather than kept forever, because an outpoint whose spender
 * has long since confirmed can never be offered again.
 */
/**
 * Who has burned a ticket to get into which room.
 *
 * ⚠ THE TICKET IS DESTROYED AT THE DOOR, so a holdings query can no longer answer
 * "is this person a member" — after entry their balance is zero by construction.
 * Membership is this table, and what makes it trustworthy is `burn_txid`: the
 * burn is a real transaction, on chain, permanent, naming the room it bought. The
 * row is an INDEX of that fact, not the fact itself.
 *
 * ⚠ AND IT IS NOT YET VERIFIED AGAINST THE CHAIN. Until the indexer question is
 * settled (DEPLOY.md), the authority here is still this database recording that
 * it saw the transaction. The improvement over holdings is that the evidence now
 * exists to be checked; it is not being checked. Do not describe this gate as
 * trustless.
 *
 * `paid_sats` is what entry cost at the moment it happened — the member's cost
 * basis, kept because the in-room card shows it against the current price and
 * reconstructing it later from a curve position is guesswork.
 */
export function applyRoomEntryMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_entries (
      symbol     TEXT NOT NULL,
      pubkey     TEXT NOT NULL,
      -- HOW this membership was acquired. There is now exactly one way, and the
      -- column is kept only so a future exception cannot be introduced silently.
      --
      -- ⚠ IT ONCE HELD 'founder' AND 'grandfathered' TOO, AND THE OWNER REMOVED
      -- BOTH (2026-08-17): *"tickets are BURNED on entry, period."* The
      -- grandfather clause was protecting holders who did not exist — this board
      -- has one real user — and the founder exemption existed because burning the
      -- founding unit made its owner vanish from their own wallet, which is a
      -- WALLET bug and was fixed as one rather than paid for with an exception to
      -- the rule.
      entry_kind TEXT NOT NULL DEFAULT 'burn',
      -- Present for 'burn' once the anchor lands; NULL for the other kinds, and
      -- NULL for a burn whose anchor never landed.
      burn_txid  TEXT,
      paid_sats  INTEGER,
      entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (symbol, pubkey)
    )
  `);
  // For databases created before the column existed.
  addColumnIfMissing(
    database,
    "room_entries",
    "entry_kind",
    "entry_kind TEXT NOT NULL DEFAULT 'burn'"
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_room_entries_pubkey ON room_entries(pubkey)");

  /**
   * ⚠ NO BACKFILL, AND THAT IS A REVERSAL. This migration briefly granted
   * membership to every existing holder, on the reasoning that they had bought
   * under hold-to-enter and their property should not be taken to tidy up a
   * schema.
   *
   * The owner removed it (2026-08-17): *"tickets are BURNED on entry, period.
   * I'm the only real user so we can apply the rule."* He is right, and the
   * clause was protecting a population of one — himself — from a rule he was
   * asking for. Nobody is admitted here. Everybody, including him, burns a ticket
   * at the door.
   *
   * ⚠ THE CONSEQUENCE, STATED SO IT IS NOT A SURPRISE: on the deploy that ships
   * this, existing holders are OUTSIDE the rooms they hold tickets for, until
   * they spend one. Their units are untouched, so entry is one tap — but it is
   * not automatic, and it cannot be, because an automatic burn would destroy a
   * unit to buy a membership nobody asked for.
   */
}

/**
 * Which on-chain contract issues a word's units.
 *
 * ⚠ THIS TABLE IS THE SEAM OF THE WHOLE MIGRATION. Today a `$Ticker` unit is a
 * row in `ticker_holdings` — real money is charged for it, and what guarantees
 * it is a database the operator runs. The pay-to-mint covenant replaces that
 * guarantee with one the network enforces, and this is where the two are joined:
 * a symbol on one side, its deploy outpoint on the other.
 *
 * Until a symbol has a row here, its units are OURS to vouch for and nothing
 * else. That is not a defect to be hidden; it is the honest state, and the app
 * should say so rather than imply a chain fact it cannot produce.
 *
 * ⚠ `token_id` IS THE DEPLOY OUTPOINT (`<txid>_<vout>`), and it is the token's
 * permanent identity under BSV-21 — not a name we assign. It cannot be known
 * before the deploy transaction exists, which is exactly why a token cannot be
 * pre-registered anywhere, including with our own indexer.
 *
 * ⚠ `whitelisted_at` EXISTS BECAUSE OUR INDEXER ONLY WATCHES WHAT IT IS TOLD
 * ABOUT. A deployed token the overlay has never heard of reads as a token with
 * no holders — an empty answer indistinguishable from a correct one. Recording
 * the moment we asked lets a reader tell "nobody holds this" from "we never
 * asked", which is the difference between a fact and a silence.
 */
export function applyTickerContractMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_contracts (
      -- The canonical UPPERCASE symbol, matching ticker_holdings/ticker_mentions.
      symbol         TEXT PRIMARY KEY,
      -- The BSV-21 token id: the deploy outpoint, "<txid>_<vout>".
      token_id       TEXT NOT NULL UNIQUE,
      -- Where the unissued supply lives, so a minter knows what to spend.
      -- Same value as token_id at deploy; kept separately because the covenant
      -- MOVES as it is spent, and the current outpoint is not the identity.
      contract_outpoint TEXT,
      -- Satoshis for the first unit, as deployed. Stored rather than assumed:
      -- the off-chain curve and the on-chain one must agree to the satoshi, and
      -- a constant that drifted would make every mint fail at broadcast.
      base_price     INTEGER NOT NULL,
      max_supply     TEXT NOT NULL,
      deployed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      -- When our overlay was asked to index it. NULL means never asked, which
      -- is NOT the same as "asked and it reported nothing".
      whitelisted_at TEXT
    )
  `);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_ticker_contracts_token ON ticker_contracts(token_id)"
  );

  /**
   * The covenant's CURRENT locking script, hex, as of `contract_outpoint`.
   *
   * ⚠ STORED RATHER THAN FETCHED, AND THAT IS A DELIBERATE TRADE. A covenant
   * transaction is ~48KB, so reading the script back off the chain before every
   * mint would download that every time and make minting depend on an explorer being
   * up. We do not need to: a mint BUILDS the next script (the continuation), so
   * the sweep already holds exactly what the next mint will spend.
   *
   * ⚠ IF IT EVER GOES STALE, MINTING STALLS — IT DOES NOT MISMINT. A wrong
   * script produces a spend of an outpoint that is already spent, which the
   * network refuses. The failure is a halt that a chain read can repair, never
   * a unit issued twice. That asymmetry is why storing it is safe.
   */
  addColumnIfMissing(database, "ticker_contracts", "contract_script", "contract_script TEXT");
}

export function applySpentOutpointMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS spent_outpoints (
      outpoint   TEXT PRIMARY KEY,
      spent_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_spent_outpoints_at ON spent_outpoints(spent_at)");

  /**
   * ⚠ THE ADDRESS IS NOT BOOKKEEPING — WITHOUT IT THE BLACKLIST ERASES ITSELF.
   *
   * Both consumers prune the same way: fetch one address's UTXO set, and drop
   * any blacklisted outpoint the response no longer contains, on the reasoning
   * that its spender must have confirmed. That reasoning holds for outpoints
   * belonging to THAT address and is false for every other one — a foreign
   * outpoint is absent because it was never going to be there.
   *
   * In a browser that never mattered: one tab, one wallet, one address. On a
   * server it does. This process spends from the platform wallet AND from every
   * configured agent's key, so an agent's post would clear the platform's
   * blacklist, and the next free boost would offer an output already spent by a
   * transaction still sitting in the mempool. Making the set durable without
   * this column would have made that worse, not better: hydration would pull
   * every address's outpoints into one process-global set for the next fetch to
   * throw away.
   *
   * Nullable because rows written before this column existed cannot be
   * attributed after the fact. They are treated as belonging to no address —
   * see `loadSpentOutpoints` — and age out within three days.
   */
  addColumnIfMissing(database, "spent_outpoints", "address", "address TEXT");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_spent_outpoints_address ON spent_outpoints(address)"
  );
}

/**
 * What each agent has already answered.
 *
 * ⚠ THIS IS A SPEND LEDGER, NOT A CACHE. Every agent reply is a paid, inscribed
 * post. Without a durable record of what has been answered, a restart, a second
 * instance, or two ticks overlapping would each re-answer the same mention and
 * pay for it again — and the duplicates are permanent, because posts cannot be
 * deleted. In-memory would have been simpler and wrong.
 *
 * The PRIMARY KEY is what enforces it: `INSERT` is attempted BEFORE the reply is
 * built, so two concurrent ticks race on the database rather than on the wallet,
 * and the loser does nothing.
 */
export function applyAgentReplyMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_replies (
      agent_pubkey TEXT NOT NULL,
      post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reply_id     INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_pubkey, post_id)
    )
  `);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_agent_replies_agent ON agent_replies(agent_pubkey, created_at)"
  );
}

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

  /**
   * How many units this edge carries. One, unless it was BOUGHT.
   *
   * ⚠ A COLUMN RATHER THAN N ROWS, and the reason is the unique index above.
   * `(post_id, symbol)` is unique for untargeted edges — deliberately, so naming
   * a word twice in one post mints one unit — which means a thousand-unit
   * purchase cannot be a thousand rows without a thousand posts to hang them
   * on. Widening the CHECK to admit a fourth `target_type` would have meant
   * rebuilding a table that already holds every unit anyone owns; adding a
   * column does not.
   *
   * ⚠ SUPPLY IS THEREFORE `SUM(units)`, NEVER `COUNT(*)`. Every reader of this
   * table that means "how many units exist" or "how many does this person hold"
   * has to sum. The ones that mean "how many POSTS said this word" (usage,
   * corpus size) correctly keep counting rows, and the difference is the whole
   * reason both kinds of query exist. Getting this wrong makes a purchase
   * invisible to the market page while the buyer's wallet shows it.
   *
   * DEFAULT 1 backfills every existing edge to exactly what it was worth
   * before: one unit for one naming.
   */
  addColumnIfMissing(
    database,
    "ticker_mentions",
    "units",
    "units INTEGER NOT NULL DEFAULT 1 CHECK (units >= 1)"
  );

  /**
   * What this mint COST, in satoshis. NULL where it is not known.
   *
   * ⚠ NULL IS A REAL ANSWER HERE AND MUST STAY ONE. Every unit minted before
   * this column existed — the whole genesis corpus — was acquired at a price
   * nobody recorded. Backfilling a guess would put a fabricated cost basis in
   * front of somebody looking at their own position, which is worse than an
   * honest gap. The UI reports how many units it can price and how many it
   * cannot.
   *
   * Only MINTS land here. A unit bought on the market carries its price in
   * `listing_fills.paid_sats` instead, because that is where a real payment was
   * verified — and a position's cost is the sum of both.
   */
  addColumnIfMissing(database, "ticker_mentions", "paid_sats", "paid_sats INTEGER");

  /**
   * Where this naming's units were actually minted on chain. NULL = not yet.
   *
   * ⚠ THIS COLUMN IS THE MINT QUEUE. Like `posts.tx_id` before it, the queue is
   * a QUERY rather than a table — rows with no txid, whose symbol has a
   * deployed covenant — so it is durable across restarts for free and cannot
   * drift from the thing it describes.
   *
   * ⚠ NULL DOES NOT MEAN "UNPAID". The author was charged the moment they
   * posted; this records whether the NETWORK has issued the units yet. Reading
   * it as an unpaid flag would let a sweep decide the debt is not owed. See
   * DECISIONS "Minting is DECOUPLED from posting" — gating a mint means DEFER,
   * never drop.
   *
   * `mint_vout` is stored rather than assumed to be 1. It IS 1 under the
   * covenant's current output order, and an outpoint recorded from a shape
   * convention is one that silently becomes wrong if the shape ever changes.
   */
  addColumnIfMissing(database, "ticker_mentions", "mint_txid", "mint_txid TEXT");
  addColumnIfMissing(database, "ticker_mentions", "mint_vout", "mint_vout INTEGER");
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_mentions_unminted
       ON ticker_mentions(symbol, id) WHERE mint_txid IS NULL`
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

/**
 * The ownership ledger, and the market that moves it.
 *
 * ⚠ WHY OWNERSHIP LEFT `ticker_mentions`. That table was doing two jobs at
 * once: recording that a post NAMED a word, and recording who HOLDS the units
 * that naming minted. The first is history and must never change — it is what
 * usage, corpus size and the word's own definition are drawn from. The second
 * moves the moment units can be sold. Selling a unit by deleting or reassigning
 * a mention row would have rewritten the record of who said what, on a board
 * whose entire premise is that the record is permanent.
 *
 * So mentions stay exactly as they are (`units` there means "this naming minted
 * N units", forever) and `ticker_holdings` says who owns them NOW. Supply is
 * identical either way — a transfer moves units between holders and never
 * changes the total — which is worth asserting in a test rather than assuming.
 *
 * `pubkey` is NOT NULL with `''` for unattributed units. Genesis posts carry no
 * key, so their units belong to nobody; a NULL would be uncomparable in a
 * PRIMARY KEY (SQLite treats NULLs as distinct) and would let the same unowned
 * pile accumulate duplicate rows.
 */
/**
 * Which pubkey an address belongs to.
 *
 * ⚠ THIS EXISTS BECAUSE A LOCKED WALLET HAS NO PUBKEY (owner, 2026-08-17). A
 * protected identity keeps its WIF encrypted and its ADDRESS in the clear, and
 * locked is the DEFAULT state — the site is deliberately designed to look and
 * read normally without unlocking. Holdings are keyed on pubkey, so a room gate
 * that only understood pubkeys treated every locked holder as a stranger and
 * showed them a paywall for a room they own. The owner hit exactly that on his
 * own thread.
 *
 * The mapping only goes one way by derivation (pubkey → address), so it has to
 * be recorded. It is written on every signed post, where the pubkey is already
 * verified, and it is PUBLIC data — an address and its pubkey are both on chain
 * in any transaction that has spent.
 *
 * ⚠ READ ACCESS ONLY. Writing still requires a signature, so nothing here
 * loosens what an unlocked key is needed for.
 */
export function applyIdentityAddressMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS identity_addresses (
      address TEXT PRIMARY KEY,
      pubkey  TEXT NOT NULL
    )
  `);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_identity_addresses_pubkey ON identity_addresses(pubkey)"
  );
  // `nyms` already carries both for anyone who claimed a name — seed from it so
  // named identities work on the first request rather than after their next post.
  database.exec(`
    INSERT OR IGNORE INTO identity_addresses (address, pubkey)
    SELECT address, pubkey FROM nyms WHERE address IS NOT NULL AND address <> ''
  `);
}

export function applyHoldingsMigration(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_holdings (
      symbol  TEXT NOT NULL,
      pubkey  TEXT NOT NULL DEFAULT '',
      units   INTEGER NOT NULL CHECK (units >= 0),
      PRIMARY KEY (symbol, pubkey)
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_holdings_pubkey ON ticker_holdings(pubkey)");

  /**
   * An OFFER to sell units. Not an on-chain event and deliberately free to
   * make: a listing moves nothing until somebody fills it, and charging for the
   * right to offer would thin the order book for no gain. What bounds it is
   * that a seller must actually hold what they list — checked at list time and
   * again at fill time, because holdings move in between.
   */
  database.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol         TEXT NOT NULL,
      seller_pubkey  TEXT NOT NULL,
      -- Where a buyer pays. Recorded at list time and never re-derived: the
      -- address a fill is verified against must be the one the seller signed
      -- for, not one looked up later.
      seller_address TEXT NOT NULL,
      units          INTEGER NOT NULL CHECK (units >= 1),
      price_sats     INTEGER NOT NULL CHECK (price_sats >= 1),
      units_sold     INTEGER NOT NULL DEFAULT 0,
      cancelled_at   TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(symbol, cancelled_at, price_sats)"
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_pubkey)");

  /**
   * A filled purchase. `tx_id` is UNIQUE — that is the replay guard, and it is
   * the same shape `posts.tx_id` uses against a paid post being submitted
   * twice: one broadcast buys one thing.
   */
  database.exec(`
    CREATE TABLE IF NOT EXISTS listing_fills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id   INTEGER NOT NULL REFERENCES listings(id),
      buyer_pubkey TEXT NOT NULL,
      units        INTEGER NOT NULL CHECK (units >= 1),
      paid_sats    INTEGER NOT NULL,
      tx_id        TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_fills_listing ON listing_fills(listing_id)");

  backfillHoldings(database);
}

/**
 * Seed the ledger from the mentions that minted every existing unit.
 *
 * ⚠ GUARDED ON THE LEDGER BEING EMPTY, like `backfillTickerMentions`. Re-running
 * it after a single sale would undo that sale by recomputing ownership from
 * history — and history, correctly, does not know about sales.
 */
export function backfillHoldings(database: Db): void {
  const existing = database.prepare("SELECT 1 FROM ticker_holdings LIMIT 1").get();
  if (existing) return;
  database.exec(`
    INSERT INTO ticker_holdings (symbol, pubkey, units)
    SELECT symbol, COALESCE(pubkey, ''), SUM(units)
      FROM ticker_mentions
     GROUP BY symbol, COALESCE(pubkey, '')
  `);
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
  // ⚠ A ticker claimed in the MAIN FEED is TOP-LEVEL, parent NULL — it does not
  // parent to the root. It used to ("so the whole board reads as one tree:
  // $OPENBOOK / $CHILD / $GRANDCHILD"), which made the root both a member of the
  // ticker set and the container of it, and put a prefix on every top-level
  // token that therefore distinguished none of them. See `repairTickerParents`
  // for the full reversal note. Parentage now records only REAL branching: a
  // ticker named inside another ticker's thread.
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
        // Nothing above it carries a ticker → it is TOP-LEVEL, parent NULL.
        //
        // ⚠ THIS FALLBACK USED TO BE `ROOT_TICKER`, "so the whole board reads as
        // one tree: $OPENBOOK / $CHILD / $GRANDCHILD". Reversed 2026-08-15,
        // deliberately, and the original reasoning is quoted because it was not
        // wrong so much as empty: a claim made on the open feed was parented to
        // the root because NOTHING enclosed it, not because it related to the
        // board. A prefix that appears on every top-level token distinguishes no
        // token from any other — it cost eleven characters of every URL and made
        // real ancestry ($Memeplex/$Words, genuinely branched inside another
        // thread) indistinguishable from the automatic kind.
        //
        // It also made the root a member of the set AND the container of it: its
        // own address collapses to `/` while it stayed a mandatory prefix on
        // everyone else's. `$OpenBooks` is now one name among many.
        //
        // ⚠ NO MIGRATION SCRIPT IS NEEDED, for the reason the old comment gives:
        // parents are recomputed from scratch on every boot, so changing this
        // line re-parents every affected row on the next start, and self-heals.
        // Genuine enclosure is untouched — `found` is set by walking the reply
        // chain, and only the "nothing above it" case lands here.
        const parent = found;
        if (parent === null || bySymbol.has(parent) || isRootTicker(parent)) {
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
  // posts.vout — the output index of the post's INSCRIPTION, paired with
  // `tx_id` to form the outpoint `<txid>_<vout>` that IS the token's identity
  // (DECISIONS.md). NULL for every post anchored the old way: an OP_RETURN
  // record has no ownable output, so there is no outpoint to record. Its
  // presence is therefore what distinguishes an inscribed post from an
  // anchored one.
  addColumnIfMissing(db, "posts", "vout", "vout INTEGER");

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
  // Ownership + the market. AFTER mentions, which it seeds itself from.
  applyHoldingsMigration(db);
  // ⚠ AFTER holdings — it backfills membership FROM `ticker_holdings`, so the
  // table it reads has to exist and be populated first.
  applyRoomEntryMigration(db);
  applyAgentReplyMigration(db);
  applySpentOutpointMigration(db);
  applyTickerContractMigration(db);
  applyTickerMeaningMigration(db);
  applyTickerBudgetMigration(db);
  applyUploadAuditMigration(db);
  applyAddendumMigration(db);
  applyNymMigration(db);
  // AFTER nyms: it seeds the address map from the names already claimed.
  applyIdentityAddressMigration(db);
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
