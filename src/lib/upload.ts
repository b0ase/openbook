/**
 * What may be uploaded, and what it is called once stored.
 *
 * Pure and dependency-free so the API route, the client-side pre-check and the
 * tests all decide the same way. A client that rejects a file the server would
 * have accepted (or worse, the reverse) produces a "nothing happened" bug with
 * no error anywhere.
 *
 * ⚠ THE EXTENSION IS DERIVED HERE, NEVER TAKEN FROM THE UPLOAD. A stored name is
 * built from a content hash plus an extension chosen from this table, so no part
 * of a user-supplied filename ever reaches the filesystem. That is what makes
 * path traversal (`../../etc/passwd`), null bytes and unicode homoglyph tricks
 * structurally impossible rather than filtered.
 */

export type UploadKind = "image" | "video" | "audio";

export type UploadReject = "empty" | "too_large" | "unsupported_type";

/**
 * MIME → canonical extension. The MIME comes from the browser and is a hint, not
 * evidence; it is used only to pick a name from this fixed table, and the served
 * `Content-Type` is derived from the extension rather than echoed back from the
 * upload. So a lie here can at worst mislabel a file the sender already owned.
 *
 * ⚠ NO SVG, DELIBERATELY. `classifyMedia` accepts `.svg` for LINKED media, where
 * it renders in a foreign origin and cannot touch us. An uploaded SVG is served
 * from OUR origin, and SVG carries `<script>` — that is stored XSS with a
 * same-origin session, which is the single worst thing this feature could add.
 * Anyone wanting a vector on the page can link one.
 *
 * ⚠ NO PDF, NO ARCHIVES, NO DOCUMENTS. This exists to put media in a post, and
 * every non-media format is a file-hosting feature with a different threat model
 * and a different abuse profile. Widening this table is a decision, not a tweak.
 */
const TYPES: Record<string, { kind: UploadKind; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/gif": { kind: "image", ext: "gif" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/avif": { kind: "image", ext: "avif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/mp4": { kind: "audio", ext: "m4a" },
  "audio/aac": { kind: "audio", ext: "aac" },
  "audio/wav": { kind: "audio", ext: "wav" },
  "audio/x-wav": { kind: "audio", ext: "wav" },
  "audio/ogg": { kind: "audio", ext: "ogg" },
  "audio/webm": { kind: "audio", ext: "weba" },
  "audio/flac": { kind: "audio", ext: "flac" },
};

/**
 * Per-kind size ceilings.
 *
 * These are a disk budget, not a quality judgement. Posting is free and the
 * volume is finite, so an unbounded upload is a way to fill the disk that the
 * database sits on — which takes the whole site down, not just the feature.
 * Video is the one worth watching: a single phone clip can be hundreds of MB.
 */
export const MAX_BYTES: Record<UploadKind, number> = {
  image: 12 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  audio: 24 * 1024 * 1024,
};

/** Every MIME type the picker should offer, for an `accept=` attribute. */
export const ACCEPTED_MIME = Object.keys(TYPES);

export type UploadCheck =
  | { ok: true; kind: UploadKind; ext: string }
  | { ok: false; reason: UploadReject; limitBytes?: number };

/**
 * Whether a file may be stored, and under what extension.
 *
 * Size is checked against the ceiling for the file's OWN kind, so the error can
 * name a real limit — "images can be up to 12MB" is actionable where "too large"
 * is not.
 */
export function checkUpload(mime: string, size: number): UploadCheck {
  const entry = TYPES[mime?.toLowerCase().split(";")[0]?.trim() ?? ""];
  if (!entry) return { ok: false, reason: "unsupported_type" };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: "empty" };
  const limit = MAX_BYTES[entry.kind];
  if (size > limit) return { ok: false, reason: "too_large", limitBytes: limit };
  return { ok: true, kind: entry.kind, ext: entry.ext };
}

/**
 * The stored name for a file, from the hash of its bytes.
 *
 * Content-addressed, so the same file uploaded twice occupies one slot and the
 * name cannot collide. It also means a stored file can never be silently
 * replaced by different bytes at the same URL — which matters because these URLs
 * end up inside posts that are anchored on-chain and cannot be edited.
 */
export function storedName(sha256Hex: string, ext: string): string {
  return `${sha256Hex}.${ext}`;
}

/**
 * A stored name, or null if the string is not one.
 *
 * The serving route matches against this instead of touching the path it was
 * given. Only 64 lowercase hex characters and a known extension can pass, so a
 * request for `../../secrets` is not sanitised — it simply fails to be a name.
 */
export function parseStoredName(name: string): { ext: string } | null {
  const m = /^([0-9a-f]{64})\.([a-z0-9]{2,5})$/.exec(name);
  if (!m) return null;
  const ext = m[2];
  if (!Object.values(TYPES).some((t) => t.ext === ext)) return null;
  return { ext };
}

/** The `Content-Type` to serve a stored file under, derived from its extension. */
export function contentTypeForExt(ext: string): string {
  for (const [mime, t] of Object.entries(TYPES)) {
    if (t.ext === ext) return mime;
  }
  return "application/octet-stream";
}

/** A human-readable byte count for error copy. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
