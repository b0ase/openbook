import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where uploaded media lives on disk.
 *
 * ⚠ THE PERSISTENT VOLUME, NOT THE BUILD. Uploads sit beside the SQLite file for
 * exactly the reason the database does: the container filesystem is replaced on
 * every deploy, so anything written outside the mounted volume disappears the
 * next time the app ships. Defaulting to `dirname(DATABASE_PATH)` means the two
 * cannot drift apart — if the database survives a deploy, so do the uploads, and
 * a misconfiguration loses both at once instead of silently losing only the
 * files (which nobody would notice until a post's image 404'd weeks later).
 *
 * ⚠ THE POST IS ON-CHAIN, THE FILE IS NOT. An OP_RETURN anchors the post text
 * permanently; the bytes of an uploaded image live on one disk with whatever
 * backups the operator keeps. This is a real asymmetry in a product whose whole
 * claim is permanence, and it is a deliberate staging decision, not an oversight
 * — on-chain storage costs satoshis per megabyte and belongs after the token
 * model funds it (TOKENS.md). Content-addressed names mean a later migration to
 * ORDFS can keep the same identifiers.
 */
function uploadDir(): string {
  const explicit = process.env.UPLOAD_PATH?.trim();
  if (explicit) return resolve(explicit);
  const dbPath = process.env.DATABASE_PATH?.trim() || "./local.db";
  return resolve(join(dirname(dbPath), "uploads"));
}

/**
 * The absolute path a stored name maps to.
 *
 * `name` must already have passed `parseStoredName` — it is a content hash plus
 * a known extension, so it contains no separators and no traversal. The
 * containment check below is belt-and-braces against a future caller that
 * forgets that rule.
 */
function pathFor(name: string): string {
  const dir = uploadDir();
  const full = resolve(join(dir, name));
  if (full !== join(dir, name)) throw new Error("upload path escaped the store");
  return full;
}

export function uploadStoreDir(): string {
  return uploadDir();
}

/**
 * Write bytes and return their content-addressed name.
 *
 * Written to a temporary name and renamed into place: `rename` is atomic within
 * a filesystem, so a reader can never observe a half-written file at a URL that
 * a post already points at. If the same bytes are already stored the write is
 * skipped — the name IS the hash, so an existing file with that name cannot have
 * different contents.
 */
export async function storeUpload(
  bytes: Buffer,
  ext: string
): Promise<{ name: string; deduped: boolean }> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `${hash}.${ext}`;
  const dir = uploadDir();
  mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  const target = pathFor(name);
  try {
    // ⚠ `turbopackIgnore` on every fs call in this file, and it is unambiguously
    // correct here: these paths point at a MOUNTED VOLUME outside the project
    // (`/data/uploads`), named by a runtime content hash. Nothing here is a
    // bundle-able asset, so without the hint Turbopack traces the whole project
    // into the server output for a path it could never have resolved anyway.
    statSync(/* turbopackIgnore: true */ target);
    return { name, deduped: true };
  } catch {
    // Not stored yet — fall through and write it.
  }
  // The temp name carries the pid and hash rather than a random suffix so a
  // crashed write leaves an obviously-orphaned file rather than something that
  // looks like a real upload.
  const tmp = `${target}.${process.pid}.part`;
  await writeFile(/* turbopackIgnore: true */ tmp, bytes);
  await rename(/* turbopackIgnore: true */ tmp, target);
  return { name, deduped: false };
}

/** Stored bytes, or null if nothing is stored under that name. */
export async function readUpload(name: string): Promise<Buffer | null> {
  try {
    return await readFile(/* turbopackIgnore: true */ pathFor(name));
  } catch {
    return null;
  }
}
