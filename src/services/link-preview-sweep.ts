/**
 * Backfill link previews for posts that never went through `createPost`.
 *
 * ⚠ WHY THIS EXISTS. Unfurling is fire-and-forget INSIDE `createPost`, so it only
 * ever runs for posts made through the app. Every seeded and imported post — the
 * 2,006 genesis rows and the 17 pulled from upstream to the fork point — was
 * written straight into SQLite and so has no preview, however many links it
 * contains. The unfurl path itself is fine; there was simply nothing to backfill
 * it. This is that.
 *
 * Modelled on `anchor-sweep.ts` and for the same reasons: the queue is a query
 * (`preview_hash IS NULL` + a link in the content), it is durable because it
 * lives in SQLite, and it is drained by ambient traffic rather than a worker.
 *
 * ⚠ ONE NETWORK FETCH PER SWEEP. Unfurling reaches out to a stranger's server,
 * and a backfill over hundreds of historical posts is exactly the shape that
 * turns into an accidental crawler. Cache hits are free and are all attached in
 * the same pass; only genuinely new URLs cost a request, and only one at a time.
 *
 * SSRF: `unfurl()` carries the full guard chain (scheme allowlist, DNS screening
 * of every resolved address, per-hop redirect screening, timeout, HTML-only
 * content type, 256KB cap). Historical URLs are no more trusted than new ones,
 * and they go through the identical path.
 */
import { db as defaultDb } from "@/lib/db";
import {
  attachPreviewToPost,
  firstLinkIn,
  hasPreview,
  savePreview,
  urlHash,
} from "@/lib/link-preview-store";
import { unfurl } from "./link-unfurl";

type DB = typeof defaultDb;

interface Candidate {
  id: number;
  content: string;
}

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

let sweepInFlight = false;
// postId -> earliest retry (ms). In-memory: a restart just retries sooner, which
// is harmless for a cosmetic backfill.
const nextAttemptAt = new Map<number, number>();
const attemptCount = new Map<number, number>();

/** Count of posts still awaiting a preview (observability / tests). */
export function pendingPreviewCount(db: DB = defaultDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM posts WHERE preview_hash IS NULL AND content LIKE '%http%'")
    .get() as { n: number };
  return row.n;
}

/**
 * Drain the preview backlog a little. Fire-and-forget; never throws. Safe to call
 * on every request — single-flight makes concurrent calls no-ops.
 */
export async function sweepPreviews(db: DB = defaultDb): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    // Newest first: the posts a reader is most likely to be looking at get their
    // previews before deep history does.
    const rows = db
      .prepare(
        `SELECT id, content FROM posts
         WHERE preview_hash IS NULL AND content LIKE '%http%'
         ORDER BY id DESC
         LIMIT 40`
      )
      .all() as Candidate[];

    const now = Date.now();
    let fetched = false;

    for (const row of rows) {
      if (now < (nextAttemptAt.get(row.id) ?? 0)) continue;
      const link = firstLinkIn(row.content);
      if (!link) {
        // Contains "http" but no link we accept (the LIKE is a coarse prefilter).
        // Back it off hard so it stops being reconsidered every sweep.
        nextAttemptAt.set(row.id, Date.now() + MAX_BACKOFF_MS);
        continue;
      }

      // Cache hit — including a cached FAILURE — costs no outbound request, so
      // these are all drained in this pass. This is what makes a link shared by
      // many posts cheap to backfill.
      if (hasPreview(db, link)) {
        attachPreviewToPost(db, row.id, urlHash(link));
        nextAttemptAt.delete(row.id);
        attemptCount.delete(row.id);
        continue;
      }

      if (fetched) continue; // one network fetch per sweep — see the header note

      fetched = true;
      try {
        const result = await unfurl(link);
        // Same mapping as `createPost`'s unfurlFirstLink — including recording a
        // FAILURE, because a stored failure is what makes the cache-hit path
        // above meaningful and stops a dead link being re-fetched forever.
        const hash = result.ok
          ? savePreview(db, {
              url: result.url,
              status: "ok",
              title: result.data.title,
              description: result.data.description,
              imageUrl: result.data.image,
              siteName: result.data.siteName,
            })
          : savePreview(db, { url: result.url, status: result.reason });
        attachPreviewToPost(db, row.id, hash);
        nextAttemptAt.delete(row.id);
        attemptCount.delete(row.id);
      } catch {
        // A throw (rather than a returned failure) means we learned nothing, so
        // back off rather than record a verdict we do not have.
        const n = (attemptCount.get(row.id) ?? 0) + 1;
        attemptCount.set(row.id, n);
        nextAttemptAt.set(
          row.id,
          Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS)
        );
      }
    }
  } catch (e) {
    console.error("OpenBook: link-preview sweep failed", e);
  } finally {
    sweepInFlight = false;
  }
}
