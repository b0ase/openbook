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

if (shouldSeed()) {
  console.log("[seed] Target DB missing/empty — seeding genesis.");
  copySeed();
} else {
  console.log("[seed] Live DB present with posts (or unreadable) — leaving it untouched.");
}
