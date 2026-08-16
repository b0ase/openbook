import { createHash } from "node:crypto";
import { db } from "./db";

/**
 * Provenance and blocking for uploaded files.
 *
 * ⚠ WHAT THIS IS FOR. The board accepts arbitrary bytes from anonymous users, so
 * some of what arrives will be illegal — CSAM is the case that matters, and it
 * is not hypothetical for any open upload endpoint. This module is the local
 * floor under whatever scanning is enabled upstream: a record of what arrived,
 * and a way to make removal permanent.
 *
 * ⚠ IT IS A FLOOR, NOT A SOLUTION, AND MUST NOT BE MISTAKEN FOR ONE. Matching is
 * on exact SHA-256, so it catches a byte-identical re-upload and nothing else —
 * one flipped pixel produces a different hash. Real detection needs perceptual
 * hashing against a licensed list (Cloudflare's CSAM Scanning Tool, an IWF or
 * NCMEC feed). What this gives you is the thing those integrations assume you
 * already have: somewhere to put a hash, and a takedown that sticks.
 *
 * ⚠ THE PDF GAP. A PDF is a container of images, so a scanner hooked to image
 * uploads does not see inside one. Whatever scanning is turned on has to cover
 * `doc` uploads too, or the document path becomes the way around it.
 */

/**
 * Key for grouping one uploader's files without storing who they are.
 *
 * Salted with a server secret so the table cannot be turned back into a list of
 * addresses by anyone who obtains it, and so the same address hashes differently
 * on a different deployment. Falls back to a fixed development salt — the
 * grouping still works, the anonymity does not, which is the right way round for
 * something that must never silently fail closed in dev.
 */
function ipHash(ip: string): string {
  const salt = process.env.UPLOAD_IP_SALT?.trim() || "openbook-dev-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export interface UploadRecord {
  name: string;
  sha256: string;
  ext: string;
  kind: string;
  bytes: number;
  originalName: string | null;
  createdAt: string;
}

/**
 * Whether these exact bytes are refused.
 *
 * Checked BEFORE writing, so a blocked file is never on disk to be served in the
 * window before anyone notices. Fails OPEN on a database error — an upload
 * endpoint that breaks when the audit table is unavailable is a worse outage
 * than a missed exact-match, and the block is a backstop rather than the primary
 * control.
 */
export function isBlockedHash(sha256: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM blocked_uploads WHERE sha256 = ?").get(sha256);
  } catch {
    return false;
  }
}

/**
 * Record that a file was stored. Best-effort: a failure here must not fail the
 * upload the user already completed.
 *
 * `INSERT OR IGNORE` because storage is content-addressed — the same file
 * uploaded twice is one row, and the FIRST upload is the one worth keeping,
 * since that is the one that answers "when did this appear and from where".
 */
export function recordUpload(entry: {
  name: string;
  sha256: string;
  ext: string;
  kind: string;
  bytes: number;
  originalName?: string | null;
  ip?: string | null;
}): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO uploads (name, sha256, ext, kind, bytes, original_name, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.name,
      entry.sha256,
      entry.ext,
      entry.kind,
      entry.bytes,
      entry.originalName?.slice(0, 200) ?? null,
      entry.ip && entry.ip !== "unknown" ? ipHash(entry.ip) : null
    );
  } catch {
    /* Provenance is a nicety at write time; the upload already succeeded. */
  }
}

export function getUpload(name: string): UploadRecord | null {
  try {
    const row = db
      .prepare(
        "SELECT name, sha256, ext, kind, bytes, original_name, created_at FROM uploads WHERE name = ?"
      )
      .get(name) as
      | {
          name: string;
          sha256: string;
          ext: string;
          kind: string;
          bytes: number;
          original_name: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      name: row.name,
      sha256: row.sha256,
      ext: row.ext,
      kind: row.kind,
      bytes: row.bytes,
      originalName: row.original_name,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Refuse these bytes from now on.
 *
 * Recording the block is the part that must succeed, and it is done FIRST: a
 * block with the file still on disk is recoverable (delete it again), while a
 * deleted file with no block is not (it comes straight back on re-upload). The
 * caller is responsible for removing the bytes.
 */
export function blockHash(sha256: string, reason?: string): void {
  db.prepare("INSERT OR IGNORE INTO blocked_uploads (sha256, reason) VALUES (?, ?)").run(
    sha256,
    reason ?? null
  );
}

/** Every stored name holding these bytes — what a takedown has to remove. */
export function namesForHash(sha256: string): string[] {
  try {
    const rows = db.prepare("SELECT name FROM uploads WHERE sha256 = ?").all(sha256) as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Other files that arrived from the same source as this one.
 *
 * The question an abuse report actually raises is not "is this file bad" but
 * "what else did they upload" — answerable here without the database ever
 * holding an address.
 */
export function siblingsOf(name: string): UploadRecord[] {
  try {
    const rows = db
      .prepare(
        `SELECT u.name, u.sha256, u.ext, u.kind, u.bytes, u.original_name, u.created_at
           FROM uploads u
           JOIN uploads target ON target.ip_hash = u.ip_hash
          WHERE target.name = ? AND u.ip_hash IS NOT NULL AND u.name != ?
          ORDER BY u.created_at DESC
          LIMIT 200`
      )
      .all(name, name) as Array<{
      name: string;
      sha256: string;
      ext: string;
      kind: string;
      bytes: number;
      original_name: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      name: r.name,
      sha256: r.sha256,
      ext: r.ext,
      kind: r.kind,
      bytes: r.bytes,
      originalName: r.original_name,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}
