/**
 * Link preview persistence — the DB half.
 *
 * Kept separate from `link-preview.ts` (pure, browser-safe) and from
 * `services/link-unfurl.ts` (network) so that each half can be reasoned about on
 * its own. This module is the only one that knows both a URL hash and a table.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { extractUrls } from "./link-preview";

type Db = ReturnType<typeof Database>;

export interface LinkPreviewRow {
  url_hash: string;
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  status: string;
  fetched_at: string;
}

/**
 * Cache key for a preview: sha256 of the NORMALISED url.
 *
 * Hashed rather than using the URL as the primary key so the key is fixed-width
 * regardless of how long the URL is — SQLite will happily index a 2KB TEXT key,
 * but it wastes space in every posts row that references it.
 */
export function urlHash(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

export function getPreview(db: Db, hash: string): LinkPreviewRow | undefined {
  return db.prepare("SELECT * FROM link_previews WHERE url_hash = ?").get(hash) as
    | LinkPreviewRow
    | undefined;
}

export interface SavePreviewInput {
  url: string;
  status: string;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  siteName?: string | null;
}

/**
 * Insert or replace a preview row and return its hash.
 *
 * Upsert rather than insert-or-ignore: a re-fetch that now succeeds should
 * overwrite the failure it replaces.
 */
export function savePreview(db: Db, input: SavePreviewInput): string {
  const hash = urlHash(input.url);
  db.prepare(`
    INSERT INTO link_previews (url_hash, url, title, description, image_url, site_name, status, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url_hash) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      image_url = excluded.image_url,
      site_name = excluded.site_name,
      status = excluded.status,
      fetched_at = excluded.fetched_at
  `).run(
    hash,
    input.url,
    input.title ?? null,
    input.description ?? null,
    input.imageUrl ?? null,
    input.siteName ?? null,
    input.status
  );
  return hash;
}

/** Point a post at a preview. No-op if the post is gone. */
export function attachPreviewToPost(db: Db, postId: number, hash: string): void {
  db.prepare("UPDATE posts SET preview_hash = ? WHERE id = ?").run(hash, postId);
}

/**
 * The first http(s) URL in a post, or null.
 *
 * ONE link per post is unfurled, deliberately. It bounds the outbound request
 * budget per post at exactly one, and the feed renders a single card anyway — a
 * post that pastes twenty links should not cost twenty fetches.
 */
export function firstLinkIn(content: string): string | null {
  return extractUrls(content, 1)[0] ?? null;
}

/**
 * Is there already a row for this URL?
 *
 * ⚠ A CACHED FAILURE COUNTS AS A HIT, ON PURPOSE. If a blocked or dead URL were
 * re-fetched every time it was posted, an attacker could turn one bad link into
 * unlimited outbound requests by posting it repeatedly. Storing the failure means
 * a hostile URL costs exactly one fetch, ever.
 *
 * The cost is that previews never refresh. That is a deliberate launch-scale
 * tradeoff, not an oversight — `idx_link_previews_status` exists so a refresh
 * sweep can find stale rows cheaply when it is worth building.
 */
export function hasPreview(db: Db, url: string): boolean {
  return getPreview(db, urlHash(url)) !== undefined;
}

/**
 * Failures worth trying again, because the WORLD may have changed rather than
 * the URL being wrong.
 *
 * A site can be mid-deploy, briefly down, slow enough to trip the 5s budget, or
 * simply not have had OpenGraph tags yet when the link was first posted. None of
 * those are properties of the link, and freezing them forever means a page that
 * works perfectly today still shows nothing because of one bad moment months ago.
 *
 * ⚠ THE OTHER REASONS ARE NOT HERE, DELIBERATELY. `invalid_url`, `blocked_address`
 * and `not_html` are verdicts about the URL itself — a private-address target does
 * not become safe by waiting, and retrying it is exactly the SSRF probe the guard
 * chain exists to refuse.
 */
const RETRYABLE_STATUSES = ["timeout", "fetch_failed", "bad_status", "too_many_redirects"];

/** How long a transient failure is trusted before it is worth one more request. */
const RETRY_AFTER_HOURS = 24;

/**
 * The stalest transient failure worth re-fetching, or null.
 *
 * ⚠ THIS MUST NOT UNDO THE ANTI-AMPLIFICATION PROPERTY ABOVE. A cached failure
 * exists so that a hostile URL costs exactly one fetch however many times it is
 * posted. That still holds: retries are keyed on the PREVIEW ROW and gated on its
 * age, so cost is bounded by TIME rather than by posting volume. Posting a bad
 * link ten thousand times still buys at most one request a day, and the reasons
 * an attacker would aim at us are not in the retryable list at all.
 *
 * Oldest first, so a backlog drains in the order it went stale rather than
 * whichever row the query planner happened to reach.
 */
export function nextStaleFailure(db: Db, olderThanHours = RETRY_AFTER_HOURS): string | null {
  const placeholders = RETRYABLE_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT url FROM link_previews
        WHERE status IN (${placeholders})
          AND fetched_at < datetime('now', ?)
        ORDER BY fetched_at ASC
        LIMIT 1`
    )
    .get(...RETRYABLE_STATUSES, `-${olderThanHours} hours`) as { url: string } | undefined;
  return row?.url ?? null;
}
