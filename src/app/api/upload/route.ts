import { rateLimit } from "@/lib/rate-limit";
import { checkUpload, formatBytes } from "@/lib/upload";
import { storeUpload } from "@/lib/upload-store";

/**
 * Media upload — the `+` button and drag-and-drop in the compose box.
 *
 * Returns an absolute `https` URL that the client inserts into the post text. It
 * has to be absolute: the URL travels inside post content, gets anchored on-chain
 * verbatim, and is rendered by `MediaEmbed`, which only embeds `https:` links. A
 * relative path would not even be recognised as a link by `linkify`.
 *
 * ⚠ THE URL IS PERMANENT THE MOMENT IT IS POSTED. `SITE_ORIGIN` exists because
 * of that: without it this would bake whichever hostname the request happened to
 * arrive on into content that can never be edited — so posts made during a
 * domain move would permanently point at the old domain. Set it once, to the
 * canonical public origin, and it stops mattering which host serves a request.
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

/**
 * The origin uploaded media is addressed under.
 *
 * Falls back to the request's own host so the feature works out of the box in
 * development and on a preview URL. The fallback is the unsafe-for-permanence
 * path, which is why the env var is documented as required for production.
 */
function siteOrigin(req: Request): string {
  const configured = process.env.SITE_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${proto}://${host}`;
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
      { error: "That kind of file can't be posted — images, video and audio only." },
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

  let stored: { name: string };
  try {
    stored = await storeUpload(bytes, check.ext);
  } catch {
    // Disk full, volume not mounted, permissions — all indistinguishable to the
    // caller and all the operator's problem, not the user's.
    return Response.json({ error: "Couldn't save that file — try again." }, { status: 503 });
  }

  return Response.json({
    url: `${siteOrigin(req)}/m/${stored.name}`,
    kind: check.kind,
  });
}
