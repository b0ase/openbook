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

export type UploadKind = "image" | "video" | "audio" | "doc";

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
 * ⚠ PDF IS ALLOWED; ARCHIVES AND DOCUMENTS ARE STILL NOT (owner, 2026-08-16).
 * This table previously read "NO PDF, NO ARCHIVES, NO DOCUMENTS", on the grounds
 * that a non-media format is a file-hosting feature with a different threat
 * model. That reasoning was right and the owner took the decision anyway, so the
 * threat model is handled rather than waved past:
 *
 *  - It is never framed in the feed automatically, and a STRANGER'S PDF is never
 *    framed at all — a card and a link. Only our own uploads preview, and only
 *    when the reader asks for one.
 *  - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` on `/m/`, so nobody
 *    can frame our user content into their own page.
 *  - The served `Content-Type` comes from the extension in this table, never from
 *    the upload, with `nosniff` — so a lie about the MIME cannot cause a browser
 *    to treat the bytes as something else.
 *  - Every stored file is hash-checked against a blocklist before it is written
 *    (`upload-audit.ts`), so a takedown can be made to STICK rather than being
 *    undone by the next re-upload.
 *
 * ⚠ THE ABUSE PROFILE IS THE REAL COST, NOT THE FORMAT. A PDF is a container of
 * images, so any image scanner hooked to `image/*` does not see inside one.
 * Whatever CSAM scanning is enabled (Cloudflare's tool, an IWF hash list) has to
 * cover this path too, or PDF becomes the documented way around it.
 *
 * Archives and office documents stay out: they carry macros and executables, and
 * nothing about them is viewable inline, which is the only thing this feature is
 * for. Widening this table further is a decision, not a tweak.
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
  "application/pdf": { kind: "doc", ext: "pdf" },
};

/**
 * ⚠ PDFs ARE SERVED UNSANDBOXED, DELIBERATELY. There was a `needsSandbox()`
 * predicate here and a `Content-Security-Policy: sandbox` on `/m/`. Both were
 * removed after testing in a real browser: Chrome's PDF viewer will not render
 * in any sandboxed context, so the header silently broke every inline preview,
 * and the risk it was buying was smaller than it claimed — PDF JavaScript runs
 * in PDFium with no DOM, cookies or storage access.
 *
 * A predicate asserting a protection we no longer apply is worse than none, so
 * it is gone rather than left to be trusted. The reasoning that replaced it
 * lives in the `/m/:name*` header block in `next.config.ts`.
 */

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
  doc: 24 * 1024 * 1024,
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

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * ⚠ THIS IS THE ONE PLACE A USER-SUPPLIED NAME IS USED FOR ANYTHING. Stored
 * names are content hashes precisely so no uploader string reaches the
 * filesystem, and that rule is unchanged — this value is display-only, for the
 * "Save as" dialog, and never touches a path.
 *
 * The header is the threat, not the disk. A newline would split the response and
 * let an uploader inject arbitrary headers; a quote would escape the quoted
 * form. So this is an ALLOWLIST of characters rather than an escape pass, and
 * the extension is forced from the stored one — an uploader cannot offer
 * `invoice.pdf.exe`, or claim a different type from the bytes we hold.
 *
 * Falls back to the short hash when nothing usable survives, so the dialog
 * always has a name and never an empty one.
 */
export function downloadFilename(originalName: string | null, sha256: string, ext: string): string {
  const segments = (originalName ?? "").split(/[\\/]/);
  const base = (segments[segments.length - 1] ?? "")
    .replace(/\.[^.]*$/, "")
    // Allowlist: letters, digits, space, dot, dash, underscore, brackets. Every
    // control character, quote, semicolon and CR/LF is excluded by construction.
    .replace(/[^\p{L}\p{N} .\-_()]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  const safe = base.length > 0 ? base : `openbooks-${sha256.slice(0, 12)}`;
  return `${safe}.${ext}`;
}

/**
 * A full `Content-Disposition` value for a download.
 *
 * Both forms are emitted: the plain `filename=` for old clients and RFC 5987
 * `filename*=` for anything non-ASCII, which is the only way a name with an
 * accent in it survives. The plain form is stripped to ASCII rather than left as
 * raw bytes, since a non-ASCII byte in an unencoded header value is what
 * actually breaks parsers.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A human-readable byte count for error copy. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
