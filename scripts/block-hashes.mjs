#!/usr/bin/env node

/**
 * Load a hash set into the upload blocklist, in bulk.
 *
 * ⚠ WHAT THIS UNBLOCKS. Every piece of the machinery already existed — uploads
 * are content-addressed by SHA-256, `isBlockedHash` is checked BEFORE anything
 * touches disk, and `blocked_uploads` survives deletion so a takedown sticks. The
 * only missing part was a way to put more than one hash in at a time, which meant
 * a licensed list of thousands (IWF, NCMEC, Project VIC, CAID) could not actually
 * be used. That is what this is.
 *
 * ⚠ EXACT MATCHING ONLY, AND THE LIMIT IS THE WHOLE POINT. SHA-256 catches a
 * byte-identical re-upload and nothing else — re-encode the image, flip one pixel,
 * strip the EXIF, and the hash changes. This is NOT detection. It is the floor
 * underneath detection: it makes a removal permanent and it consumes the lists
 * that already exist. Perceptual hashing (PhotoDNA, Cloudflare's CSAM Scanning
 * Tool) is the thing that actually finds novel material, and this does not replace
 * a decision to adopt one.
 *
 * ⚠ THE PDF GAP APPLIES HERE TOO. A PDF is a container of images, so hashing the
 * container catches only that exact file. See `upload-audit.ts`.
 *
 *   node scripts/block-hashes.mjs <file> [--reason "IWF 2026-08"] [--dry-run]
 *   node scripts/block-hashes.mjs -            # read from stdin
 *
 * Input is deliberately forgiving, because published lists are not uniform: one
 * entry per line, `#` comments and blanks ignored, and the FIRST 64-character hex
 * token on a line is taken — so `<hash>,<filename>` and `<hash>  <size>` CSV/TSV
 * exports work without pre-processing. Anything with no hash on it is reported as
 * skipped rather than silently dropped, because a list that half-loaded and said
 * nothing is worse than one that refused.
 *
 * ⚠ THIS DOES NOT DISCHARGE THE REPORTING OBLIGATION. Blocking bytes is not the
 * same as reporting them — in the UK to the IWF and the police, in the US to
 * NCMEC. See `scripts/takedown.mjs`.
 */

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reasonIdx = args.indexOf("--reason");
const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : null;
const source = args.find((a) => !a.startsWith("--") && a !== reason);

if (!source) {
  console.error("usage: node scripts/block-hashes.mjs <file|-> [--reason TEXT] [--dry-run]");
  process.exit(1);
}

const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");

// A 64-char hex run, not anchored, so it is found wherever it sits on the line.
const HASH = /\b[0-9a-fA-F]{64}\b/;

const hashes = new Set();
let skipped = 0;
let comments = 0;

for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith("#")) {
    comments++;
    continue;
  }
  const m = HASH.exec(trimmed);
  if (!m) {
    skipped++;
    continue;
  }
  // Stored lowercase because `isBlockedHash` compares against a lowercase digest
  // from `createHash(...).digest("hex")`. An uppercase list would load fine and
  // then match nothing, which is exactly the silent failure worth avoiding.
  hashes.add(m[0].toLowerCase());
}

console.log(`read     ${source === "-" ? "<stdin>" : source}`);
console.log(`hashes   ${hashes.size} unique`);
if (comments) console.log(`comments ${comments} ignored`);
if (skipped) console.log(`⚠ skipped ${skipped} line(s) with no 64-char hash on them`);

if (hashes.size === 0) {
  console.error("Nothing to load — check the file format.");
  process.exit(1);
}

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

const dbPath = process.env.DATABASE_PATH?.trim() || "./local.db";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// The table is created by the app's own migration. Refusing here rather than
// creating it keeps one definition of the schema — a second CREATE in a script is
// how two shapes of the same table come to exist on two machines.
const exists = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blocked_uploads'")
  .get();
if (!exists) {
  console.error(
    `No blocked_uploads table in ${dbPath}. Start the app once so migrations run, then re-run this.`
  );
  process.exit(1);
}

const before = db.prepare("SELECT COUNT(*) AS n FROM blocked_uploads").get().n;

// `INSERT OR IGNORE` so re-running a list, or loading two lists that overlap, is
// harmless — and so an interrupted run can simply be repeated.
const insert = db.prepare("INSERT OR IGNORE INTO blocked_uploads (sha256, reason) VALUES (?, ?)");
db.transaction(() => {
  for (const h of hashes) insert.run(h, reason);
})();

const after = db.prepare("SELECT COUNT(*) AS n FROM blocked_uploads").get().n;

console.log(`\nblocklist ${before} → ${after} (${after - before} new)`);

/**
 * ⚠ A BLOCK DOES NOT REMOVE WHAT IS ALREADY STORED. The check runs on upload, so
 * anything matching that arrived BEFORE this list did is still on disk and still
 * served. Naming them is the difference between a load that looks complete and
 * one that is.
 */
const already = db
  .prepare(
    `SELECT u.name FROM uploads u
      JOIN blocked_uploads b ON b.sha256 = u.sha256
     ORDER BY u.created_at DESC`
  )
  .all();

if (already.length) {
  console.log(`\n⚠ ${already.length} ALREADY-STORED file(s) match this blocklist.`);
  console.log("  They are on disk now and this script does not delete bytes. Run:");
  for (const r of already.slice(0, 20)) {
    console.log(`    node scripts/takedown.mjs ${r.name}`);
  }
  if (already.length > 20) console.log(`    …and ${already.length - 20} more`);
  process.exitCode = 2;
} else {
  console.log("No already-stored file matches this list.");
}
