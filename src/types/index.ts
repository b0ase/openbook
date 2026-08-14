// Shared domain types for OpenBook.

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
}

export type Post = PostRow & { boot_count: number };

// ── Bootboard ──────────────────────────────────────────────────────────────

export interface BootboardRow {
  id: number;
  post_id: number;
  boosted_by: string;
  boosted_by_name: string | null;
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
