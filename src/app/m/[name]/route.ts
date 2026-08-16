import {
  contentDisposition,
  contentTypeForExt,
  downloadFilename,
  needsSandbox,
  parseStoredName,
} from "@/lib/upload";
import { getUpload, isBlockedHash } from "@/lib/upload-audit";
import { readUpload } from "@/lib/upload-store";

/**
 * Serving uploaded media.
 *
 * A route rather than a file in `public/`, because uploads live on the mounted
 * volume — `public/` is part of the build and is replaced on every deploy.
 *
 * ⚠ THE PATH IS MATCHED, NOT SANITISED. `parseStoredName` accepts only 64
 * lowercase hex characters plus an extension from the upload table. A request
 * for `../../local.db` does not get cleaned up; it fails to be a name and 404s.
 * Never replace this with string munging on the incoming path.
 *
 * The `Content-Type` is derived from the stored extension, never echoed from the
 * upload, and `nosniff` stops a browser from second-guessing it. Together with
 * the SVG exclusion in `upload.ts`, that is what keeps same-origin hosting of
 * user files from becoming stored XSS.
 */

// Content-addressed: the bytes at a given name can never change, so this is one
// of the rare cases where a year-long immutable cache is simply correct.
const CACHE = "public, max-age=31536000, immutable";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const parsed = parseStoredName(name);
  if (!parsed) return new Response("Not found", { status: 404 });

  // ⚠ CHECKED ON EVERY READ, NOT ONLY AT UPLOAD. A file blocked after it was
  // stored has to stop being served immediately, and the bytes may still be on
  // disk (or back on it, since the name is the hash). 410 rather than 404: the
  // resource existed and is gone deliberately, which is what a caching proxy and
  // an operator reading logs both need to be told.
  const meta = getUpload(name);
  const sha = meta?.sha256 ?? name.split(".")[0];
  if (isBlockedHash(sha)) return new Response("Removed", { status: 410 });

  const bytes = await readUpload(name);
  if (!bytes) return new Response("Not found", { status: 404 });

  // `?download` is the "save this" affordance. Everything else about the
  // response is identical — same bytes, same type — so a download can never
  // serve something different from what was previewed.
  const download = new URL(req.url).searchParams.has("download");

  const headers: Record<string, string> = {
    "Content-Type": contentTypeForExt(parsed.ext),
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": CACHE,
    "X-Content-Type-Options": "nosniff",
    // Inline so an image renders in the feed, with an empty filename so the
    // stored hash is never presented as something to save under.
    "Content-Disposition": download
      ? contentDisposition(downloadFilename(meta?.originalName ?? null, sha, parsed.ext))
      : "inline",
  };

  // ⚠ ACTIVE FORMATS GET AN OPAQUE ORIGIN. A PDF can contain JavaScript, and a
  // PDF served as an ordinary same-origin document is a script running on our
  // origin with our cookies — stored XSS, from a file any anonymous user can
  // upload. `sandbox` with no allow-* puts the response in a unique opaque
  // origin: the browser's viewer still renders it, embedded script cannot reach
  // anything of ours. Removing this line re-opens that hole silently, because
  // nothing about the page will look different.
  if (needsSandbox(parsed.ext)) {
    headers["Content-Security-Policy"] = "sandbox";
  }

  return new Response(new Uint8Array(bytes), { headers });
}
