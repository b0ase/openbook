/**
 * Seed the volume database on first boot.
 *
 * Railway volumes start EMPTY, so on a fresh deploy the app would otherwise
 * create a blank local.db and serve an empty feed. This copies the bundled
 * genesis DB (`seed/genesis.db` — 2006 backdated, on-chain posts) into
 * DATABASE_PATH, but ONLY when the target is missing or has ZERO posts.
 *
 * Safety: once the live DB has any posts it is NEVER overwritten — so real
 * posts + earnings survive every redeploy. Idempotent. The stale empty DB that
 * the shakeout left on the volume (0 posts) IS replaced, which is what we want.
 *
 * Runs before `npm start` (see the Dockerfile CMD).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.DATABASE_PATH || path.join(process.cwd(), "local.db");
const seed = path.join(__dirname, "..", "seed", "genesis.db");

/**
 * Seed ONLY when it's provably safe: the file is absent, OR it opens cleanly
 * with a `posts` table holding 0 rows, OR it has no `posts` table yet (blank
 * DB). Any OTHER outcome (can't open, malformed/corrupt, unexpected error) →
 * false → leave the existing DB untouched. This fails toward PRESERVING real
 * data: a momentarily-locked or corrupted DB (holding posts + earnings) is
 * never deleted and overwritten with genesis.
 */
function shouldSeed() {
  if (!fs.existsSync(target)) return true;
  let db;
  try {
    db = new Database(target, { readonly: true });
  } catch (err) {
    console.error(
      `[seed] Target exists but won't open — NOT seeding (preserving it): ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM posts").get();
    return (row?.c ?? 0) === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return true; // blank DB, no posts table yet → safe to seed
    console.error(`[seed] Unexpected read error — NOT seeding (preserving it): ${msg}`);
    return false; // could be corruption over real data → preserve it
  } finally {
    db.close();
  }
}

function copySeed() {
  // Guard FIRST: never delete the target if we have no seed to replace it with.
  if (!fs.existsSync(seed)) {
    console.error(`[seed] MISSING seed file at ${seed} — skipping seed, starting as-is.`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Drop any stale WAL/SHM sidecars so the copied DB opens clean.
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(target + ext, { force: true });
      } catch {}
    }
    fs.copyFileSync(seed, target);
    console.log(`[seed] Seeded genesis DB → ${target}`);
  } catch (err) {
    // Never let a seed failure crash startup — log and let the app boot (it'll
    // create an empty DB, and the next redeploy re-attempts the seed since the
    // count is still 0). Self-healing.
    console.error(
      `[seed] Seed copy FAILED: ${err instanceof Error ? err.message : String(err)} — starting as-is.`
    );
  }
}

/**
 * TOP-UP: add seed posts the live DB is missing, WITHOUT touching anything it
 * already has.
 *
 * Why this exists: the fork's seed originally stopped at post 2006, and the
 * shared history with upstream actually runs to the fork point at 2023. The live
 * volume already had 2006 posts, so `shouldSeed()` correctly refuses to
 * re-seed — but that would strand the last 17 posts of shared history forever.
 *
 * ⚠ IT CAN ONLY ADD, NEVER MODIFY. `INSERT OR IGNORE` keyed on the primary key
 * means an id the live DB already holds is skipped, so no existing post, boot or
 * payout can be altered by this.
 *
 * ⚠ AND IT ONLY RUNS WHEN THE LIVE DB IS A SUBSET OF THE SEED. Once this fork
 * has original posts of its own, their ids interleave with the seed's range and
 * "missing id" stops meaning "inherited post we lack". The guard below detects
 * that and skips, permanently — this is a one-time reconciliation, not an
 * ongoing sync.
 */
function topUpFromSeed() {
  if (!fs.existsSync(seed) || !fs.existsSync(target)) return;
  let live;
  let src;
  try {
    live = new Database(target);
    src = new Database(seed, { readonly: true });

    const liveMax = live.prepare("SELECT COALESCE(MAX(id),0) AS m FROM posts").get().m;
    const seedMax = src.prepare("SELECT COALESCE(MAX(id),0) AS m FROM posts").get().m;
    if (seedMax <= liveMax) return; // nothing newer to add

    // Prefix guard: the live DB must be a FAITHFUL PREFIX of the seed — every
    // live post must match the seed's post at the same id, CONTENT INCLUDED.
    //
    // ⚠ COMPARING IDS ALONE IS NOT ENOUGH, and the test that proved it is the
    // reason this comment exists. Post ids auto-increment, so the fork's first
    // original post takes id 2007 — an id the extended seed also uses for an
    // inherited post. An id-only check sees 2007 in both, calls it a subset, and
    // happily interleaves inherited posts 2008..2023 around an original one.
    // Nothing is destroyed (INSERT OR IGNORE protects the original), but the
    // timeline silently becomes neither ours nor theirs, which is the exact
    // outcome this whole reconciliation exists to avoid.
    const seedContent = new Map(
      src.prepare("SELECT id, content FROM posts").all().map((r) => [r.id, r.content])
    );
    const liveRows = live.prepare("SELECT id, content FROM posts").all();
    const diverged = liveRows.filter((r) => seedContent.get(r.id) !== r.content);
    if (diverged.length) {
      console.log(
        `[seed] Live DB has ${diverged.length} post(s) of its own (first at id ${diverged[0].id}) — diverged, skipping top-up.`
      );
      return;
    }

    const rows = src.prepare("SELECT * FROM posts WHERE id > ? ORDER BY id ASC").all(liveMax);
    if (!rows.length) return;

    // Column-by-column rather than SELECT *: the live DB has been migrated
    // (parent_id, root_id, preview_hash) and the seed has not, so the shapes
    // differ. root_id is left NULL here and backfilled by applyThreadingMigration
    // when the app boots — the same path the original seed takes.
    const insert = live.prepare(`
      INSERT OR IGNORE INTO posts (id, content, author_name, signature, pubkey, tx_id, created_at)
      VALUES (@id, @content, @author_name, @signature, @pubkey, @tx_id, @created_at)
    `);
    const run = live.transaction((all) => {
      for (const r of all) {
        insert.run({
          id: r.id,
          content: r.content,
          author_name: r.author_name,
          signature: r.signature ?? null,
          pubkey: r.pubkey ?? null,
          tx_id: r.tx_id ?? null,
          created_at: r.created_at,
        });
      }
    });
    run(rows);
    console.log(`[seed] Topped up ${rows.length} inherited post(s): ids ${liveMax + 1}..${seedMax}`);
  } catch (err) {
    // Never crash startup over this — the app is perfectly usable without the
    // last few inherited posts, and the next boot re-attempts.
    console.error(
      `[seed] Top-up skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      live?.close();
    } catch {}
    try {
      src?.close();
    } catch {}
  }
}

if (shouldSeed()) {
  console.log("[seed] Target DB missing/empty — seeding genesis.");
  copySeed();
} else {
  console.log("[seed] Live DB present with posts — leaving existing rows untouched.");
  topUpFromSeed();
}
