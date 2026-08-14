import { contentTypeForExt, parseStoredName } from "@/lib/upload";
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

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const parsed = parseStoredName(name);
  if (!parsed) return new Response("Not found", { status: 404 });

  const bytes = await readUpload(name);
  if (!bytes) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentTypeForExt(parsed.ext),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": CACHE,
      "X-Content-Type-Options": "nosniff",
      // Inline so an image renders in the feed, with an empty filename so the
      // stored hash is never presented as something to save under.
      "Content-Disposition": "inline",
    },
  });
}
