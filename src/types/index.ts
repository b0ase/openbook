// Shared domain types for OpenBooks.

export interface Identity {
  name: string;
  address: string;
  wif: string;
  // Compressed-hex secp256k1 public key derived from `wif`. Cached on the
  // identity so consumers (post signing, boot orchestration, fairness
  // weighting, on-chain logging) don't re-derive it. Identity-creating sites
  // in `services/bsv/identity.ts` derive this in one place; consumers MUST
  // NOT compute it ad-hoc.
  pubkey: string;
}

// ── Posts ──────────────────────────────────────────────────────────────────

export interface PostRow {
  id: number;
  content: string;
  author_name: string;
  /**
   * The author's claimed `$Nym`, canonical (uppercase, no `$`), or null while
   * they are still anonymous. Joined live from `nyms` — see POST_SELECT — so it
   * is the name the author goes by NOW, not the one current when they posted.
   * Renderers show this INSTEAD OF `author_name` when present; `author_name`
   * remains the generated `anon_xxxx` fallback.
   */
  author_nym: string | null;
  signature: string | null;
  pubkey: string | null;
  tx_id: string | null;
  created_at: string;
  /**
   * Threading (THREADS.md). `parent_id` is the immediate parent; NULL means this
   * post is a thread ROOT, which is what the feed shows and what a token ticker
   * attaches to. `root_id` is the thread this post belongs to, denormalised so a
   * thread's contents are `WHERE root_id = ?` — one indexed scan rather than a
   * recursive walk, because that query sits on the token-allocation path.
   *
   * `root_id` is self-referential for roots (root_id === id). It is nullable only
   * because ALTER TABLE ADD COLUMN cannot backfill; the migration roots every
   * pre-threading row, so NULL should not appear in practice.
   */
  parent_id: number | null;
  root_id: number | null;
  /**
   * Link preview (see `lib/link-preview-store.ts`). Points at `link_previews`.
   * Null until the fire-and-forget unfurl lands — or forever, if the post has
   * no link.
   */
  preview_hash: string | null;
}

/**
 * A post's link preview, flattened onto the row by the `POST_SELECT` join.
 *
 * Flat rather than nested because better-sqlite3 returns rows, not object
 * graphs. `preview_status` is `'ok'` or an `UnfurlFailure` — a failed unfurl is
 * still recorded, so the UI can tell "not fetched yet" (all null) apart from
 * "fetched and there was nothing to show" (status set, title null).
 */
export interface PostPreviewFields {
  preview_url: string | null;
  preview_title: string | null;
  preview_description: string | null;
  preview_image: string | null;
  preview_site_name: string | null;
  preview_status: string | null;
}

/**
 * A preview that landed after the client already had the post.
 *
 * Carried on its own poll channel (`getPostPreviews`) because nothing else
 * re-fetches a post once the client holds it — see that function for why.
 */
export type PostPreviewUpdate = { id: number } & PostPreviewFields;

/**
 * `reply_count` counts posts whose `root_id` is this post, EXCLUDING the post
 * itself — a thread with no replies reads 0, not 1. Like `boot_count` it is
 * computed by the `POST_SELECT` join rather than fetched separately, so the feed
 * never needs a second round-trip and the count can never drift from the row it
 * is rendered beside.
 */
export type Post = PostRow & {
  boot_count: number;
  reply_count: number;
  /** Newest reply in this thread, for the inline preview in the feed. */
  latest_reply_content?: string | null;
  latest_reply_author?: string | null;
  latest_reply_nym?: string | null;
} & Partial<PostPreviewFields>;

// ── Bootboard ──────────────────────────────────────────────────────────────

export interface BootboardRow {
  id: number;
  post_id: number;
  boosted_by: string;
  boosted_by_name: string | null;
  /** The spender's claimed `$Nym`, canonical, or null. Shown INSTEAD of
   *  `boosted_by_name` — an identity must not read as `$B0ase` when it writes
   *  and `anon_xxxx` when it spends. */
  boosted_by_nym?: string | null;
  booted_at: string;
  held_until: string | null;
  content: string;
  author_name: string;
  signature: string | null;
}

export interface BootboardHistoryRow {
  post_id: number;
  boosted_by: string;
  boosted_by_name: string | null;
  /** The spender's claimed `$Nym`, canonical, or null. Shown INSTEAD of
   *  `boosted_by_name` — an identity must not read as `$B0ase` when it writes
   *  and `anon_xxxx` when it spends. */
  boosted_by_nym?: string | null;
  booted_at: string;
  held_until: string;
  duration_seconds: number;
  content: string;
  author_name: string;
}

export interface BootboardData {
  current: BootboardRow | null;
  history: BootboardHistoryRow[];
  totalBoots: number;
}
