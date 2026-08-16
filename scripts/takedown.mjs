#!/usr/bin/env node

/**
 * Remove an uploaded file, permanently.
 *
 * ⚠ WHAT THIS IS FOR. The board accepts arbitrary bytes from anonymous users, so
 * sooner or later something arrives that has to come off immediately — illegal
 * content above all. Before this existed there was no way to delete an upload at
 * all, which meant the only answer to a report was taking the whole site down.
 *
 * ⚠ ORDER MATTERS AND IS NOT COSMETIC. The hash is BLOCKED first, the bytes are
 * deleted second. Storage is content-addressed, so a deleted file re-uploads to
 * exactly the name it had a moment earlier — deleting without blocking is not a
 * takedown, it is a pause. If this script is interrupted between the two steps
 * the file is blocked but still on disk, which serves 410 and is recoverable;
 * the other order would leave it silently available again.
 *
 *   node scripts/takedown.mjs <name-or-url-or-sha256> [reason]
 *   node scripts/takedown.mjs --siblings <name>      # what else came from there
 *
 * Reports of child sexual abuse material must ALSO go to the authorities — in
 * the UK the IWF (iwf.org.uk) and the police; in the US, NCMEC. Removing the
 * file is not the whole of the obligation and this script does not discharge it.
 */

import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

const dbPath = process.env.DATABASE_PATH?.trim() || "./local.db";
const uploadDir = process.env.UPLOAD_PATH?.trim()
  ? resolve(process.env.UPLOAD_PATH.trim())
  : resolve(join(dirname(dbPath), "uploads"));

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/takedown.mjs <name|url|sha256> [reason]");
  console.error("       node scripts/takedown.mjs --siblings <name>");
  process.exit(1);
}

const db = new Database(dbPath);

/** Accept a stored name, a full URL, or a bare hash — whatever the report quoted. */
function toHash(input) {
  const tail = input.trim().split("/").pop().split("?")[0];
  const bare = tail.replace(/\.[a-z0-9]+$/i, "");
  if (/^[0-9a-f]{64}$/i.test(bare)) return bare.toLowerCase();
  return null;
}

if (args[0] === "--siblings") {
  const name = args[1];
  if (!name) {
    console.error("--siblings needs a stored name");
    process.exit(1);
  }
  const rows = db
    .prepare(
      `SELECT u.name, u.kind, u.bytes, u.original_name, u.created_at
         FROM uploads u
         JOIN uploads t ON t.ip_hash = u.ip_hash
        WHERE t.name = ? AND u.ip_hash IS NOT NULL
        ORDER BY u.created_at DESC LIMIT 200`
    )
    .all(name);
  if (rows.length === 0) {
    console.log("No siblings found (no provenance recorded for that name).");
  } else {
    console.log(`${rows.length} file(s) from the same source:\n`);
    for (const r of rows) {
      console.log(`  ${r.created_at}  ${r.kind.padEnd(5)}  ${r.name}  ${r.original_name ?? ""}`);
    }
    console.log("\nTake each down with: node scripts/takedown.mjs <name> '<reason>'");
  }
  process.exit(0);
}

const hash = toHash(args[0]);
if (!hash) {
  console.error(`Not a stored name, URL or hash: ${args[0]}`);
  process.exit(1);
}
const reason = args[1] ?? "takedown";

// 1. Block first. This is the step that must not be skipped.
db.prepare("INSERT OR IGNORE INTO blocked_uploads (sha256, reason) VALUES (?, ?)").run(
  hash,
  reason
);
console.log(`blocked  ${hash}  (${reason})`);

// 2. Then remove every stored name holding those bytes.
const names = db
  .prepare("SELECT name FROM uploads WHERE sha256 = ?")
  .all(hash)
  .map((r) => r.name);

// A file uploaded before provenance existed has no row, so fall back to the
// names the hash could plausibly be stored under rather than missing it.
if (names.length === 0) {
  for (const ext of ["jpg", "png", "gif", "webp", "avif", "mp4", "webm", "mov", "pdf"]) {
    names.push(`${hash}.${ext}`);
  }
}

let removed = 0;
for (const name of names) {
  try {
    await unlink(join(uploadDir, name));
    console.log(`deleted  ${name}`);
    removed++;
  } catch {
    /* Not stored under that name — expected for the fallback sweep. */
  }
}

console.log(
  removed === 0
    ? "\nNo bytes found on disk. The hash is blocked, so it cannot be re-uploaded."
    : `\n${removed} file(s) removed and the hash blocked — re-upload will be refused.`
);
