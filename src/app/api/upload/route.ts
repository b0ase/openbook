import { createHash } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { siteOrigin } from "@/lib/site-origin";
import { checkUpload, downloadFilename, formatBytes } from "@/lib/upload";
import { isBlockedHash, recordUpload } from "@/lib/upload-audit";
import { storeUpload } from "@/lib/upload-store";

/**
 * Media upload — the `+` button and drag-and-drop in the compose box.
 *
 * Returns an absolute `https` URL that the client inserts into the post text. It
 * has to be absolute: the URL travels inside post content, gets anchored on-chain
 * verbatim, and is rendered by `MediaEmbed`, which only embeds `https:` links. A
 * relative path would not even be recognised as a link by `linkify`.
 *
 * ⚠ THE URL IS PERMANENT THE MOMENT IT IS POSTED, so it must never come from the
 * request host. `siteOrigin()` (lib/site-origin.ts) is the one resolver — the
 * same one the social cards use, because the failure mode is identical: behind
 * Railway's proxy the request host is `localhost:8080`, which would have been
 * baked into post content that can never be edited. Set `SITE_ORIGIN` to the
 * canonical public origin and it stops mattering which host serves a request.
 *
 * Guards mirror the other write paths: per-IP rate limit, a hard byte ceiling
 * per media kind, and an extension chosen by us rather than by the uploader.
 */

// Uploads are large and slow relative to everything else here, so the limit is
// on the low side: this is a compose-box affordance, not a bulk import.
const LIMIT_PER_MINUTE = 12;

function clientIp(req: Request): string {
  // `.split(",")[0]` so a spoofed multi-hop header cannot extend the budget;
  // `x-real-ip` fallback for proxies that drop x-forwarded-for. See DEPLOY.md.
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function POST(req: Request) {
  const rl = rateLimit(`upload:${clientIp(req)}`, {
    limit: LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });
  if (!rl.success) {
    return Response.json({ error: "Slow down — too many uploads." }, { status: 429 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }
  if (!file) return Response.json({ error: "No file received." }, { status: 400 });

  // Checked against the declared size BEFORE reading the body into memory, so an
  // oversized upload costs a header parse rather than 500MB of heap.
  const check = checkUpload(file.type, file.size);
  if (!check.ok) {
    if (check.reason === "too_large") {
      return Response.json(
        { error: `That file is too big — the limit is ${formatBytes(check.limitBytes ?? 0)}.` },
        { status: 413 }
      );
    }
    if (check.reason === "empty") {
      return Response.json({ error: "That file is empty." }, { status: 400 });
    }
    return Response.json(
      { error: "That kind of file can't be posted — images, video, audio and PDFs only." },
      { status: 415 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // `file.size` is client-declared; the real length is only known once read. A
  // body larger than it claimed must not slip past the ceiling.
  const recheck = checkUpload(file.type, bytes.byteLength);
  if (!recheck.ok) {
    return Response.json({ error: "That file is too big." }, { status: 413 });
  }

  // ⚠ BLOCKED BEFORE IT IS WRITTEN, NOT AFTER. Storage is content-addressed, so
  // a removed file re-uploads to exactly the name it had before — deleting bytes
  // is not a takedown unless the hash is refused on the way in. Hashed here
  // rather than taken from `storeUpload` so nothing blocked ever touches disk.
  //
  // Deliberately vague to the uploader: naming the reason tells someone probing
  // the blocklist which of their files is known, which is information worth more
  // to them than to us.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (isBlockedHash(sha256)) {
    return Response.json({ error: "That file can't be uploaded." }, { status: 403 });
  }

  let stored: { name: string };
  try {
    stored = await storeUpload(bytes, check.ext);
  } catch {
    // Disk full, volume not mounted, permissions — all indistinguishable to the
    // caller and all the operator's problem, not the user's.
    return Response.json({ error: "Couldn't save that file — try again." }, { status: 503 });
  }

  // Provenance for abuse response: when it arrived, roughly from where, and what
  // it was called. Best-effort by design — the file is already stored, and
  // failing the request now would be a worse outcome than a missing row.
  recordUpload({
    name: stored.name,
    sha256,
    ext: check.ext,
    kind: check.kind,
    bytes: bytes.byteLength,
    originalName: typeof file.name === "string" ? file.name : null,
    ip: clientIp(req),
  });

  return Response.json({
    url: `${siteOrigin()}/m/${stored.name}`,
    kind: check.kind,
    // The compose box shows a filename for a document, where a thumbnail is not
    // available and a bare hash URL tells the poster nothing about what attached.
    name: downloadFilename(typeof file.name === "string" ? file.name : null, sha256, check.ext),
  });
}
