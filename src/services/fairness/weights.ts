/**
 * Contribution weight calculation.
 * sqrt(engagement) × time_decay per post, summed per contributor.
 * Posts are attributed directly to their signing pubkey.
 *
 * The weight SOURCE is pluggable (`WeightSource` below). `calculateWeights` is a
 * facade over whichever source is registered; `postActivityWeightSource` is the
 * default and is the historical behaviour, unchanged. Nothing downstream —
 * `split.ts`, `boot-orchestrator.ts`, `/api/boot-shares` — knows or cares where a
 * weight came from, which is what makes the source swappable at all.
 *
 * This is a seam, not a feature: with no `setWeightSource` call anywhere, the
 * module behaves exactly as it did before the interface existed.
 */

import { PublicKey } from "@bsv/sdk";
import { FAIRNESS_CONFIG } from "./config";

const { halfLifeDays, engagementMultiplier, scalingFn } = FAIRNESS_CONFIG;

export interface ContributorWeight {
  pubkey: string;
  address: string;
  weight: number;
  postCount: number;
  totalBoots: number;
}

/**
 * A strategy for deriving contributor weights — the denominator of every payout
 * split. Implementations MUST be pure with respect to the money path: return the
 * weight vector, touch no funds, hold no balances.
 *
 * `calculate` receives the launch epoch so a source can honour the pool cutoff
 * (see FAIRNESS_CONFIG.launchTs). A source that ignores it is opting every
 * pre-launch post back into the pool — do that deliberately, never by omission.
 */
export interface WeightSource {
  /** Stable identifier, for logging and diagnostics. */
  readonly name: string;
  calculate(db: import("better-sqlite3").Database, launchTs: string): ContributorWeight[];
  /** Drop any memoized state. Called on source swap and by tests. */
  clearCache(): void;
}

// Cache weights to avoid full table scan on every boot.
// Invalidated after 30 seconds — weights only change when posts or boots change.
// The cache is process-global and NOT keyed on launchTs — safe because launchTs is
// a deploy-constant (only tests vary it, and they _clearWeightsCache() per case).
const WEIGHTS_CACHE_TTL_MS = 30_000;
let _cachedWeights: ContributorWeight[] | null = null;
let _weightsCachedAt = 0;

interface PostRow {
  pubkey: string;
  boot_count: number;
  created_at: string;
}

/**
 * Derive BSV address from a pubkey string.
 */
function pubkeyToAddress(pubkey: string): string {
  try {
    return PublicKey.fromString(pubkey).toAddress().toString();
  } catch {
    return "";
  }
}

/**
 * Post-activity weight calculation — the default source, and the only behaviour
 * this module had before `WeightSource` existed.
 * Results are cached for 30 seconds to avoid repeated full table scans.
 */
function computePostActivityWeights(
  db: import("better-sqlite3").Database,
  launchTs: string
): ContributorWeight[] {
  const now = Date.now();
  if (_cachedWeights && now - _weightsCachedAt < WEIGHTS_CACHE_TTL_MS) {
    return _cachedWeights;
  }

  // Get all signed posts with boot counts. The `created_at >= launchTs` gate drops
  // pre-launch history (backdated genesis seed + pre-launch test posts) from the
  // 80% pool so it starts fresh at launch. Excluded posts still earn the
  // pool-independent 15% creator bonus when boosted (split.ts).
  const posts = db
    .prepare(`
    SELECT p.pubkey, COALESCE(bc.boot_count, 0) as boot_count, p.created_at
    FROM posts p
    LEFT JOIN (SELECT post_id, COUNT(*) as boot_count FROM bootboard GROUP BY post_id) bc
      ON bc.post_id = p.id
    WHERE p.pubkey IS NOT NULL AND p.created_at >= ?
  `)
    .all(launchTs) as PostRow[];

  // Aggregate weights by pubkey
  const byPubkey = new Map<string, { weight: number; posts: number; boots: number }>();

  for (const post of posts) {
    const resolvedPubkey = post.pubkey;

    const ageDays =
      (now - new Date(`${post.created_at.replace(" ", "T")}Z`).getTime()) / 86_400_000;
    const decay = 0.5 ** (ageDays / halfLifeDays);
    const engagement = 1 + post.boot_count * engagementMultiplier;
    const postWeight = scalingFn(engagement) * decay;

    const entry = byPubkey.get(resolvedPubkey) ?? { weight: 0, posts: 0, boots: 0 };
    entry.weight += postWeight;
    entry.posts += 1;
    entry.boots += post.boot_count;
    byPubkey.set(resolvedPubkey, entry);
  }

  const result = Array.from(byPubkey.entries())
    .filter(([, data]) => data.weight > 0)
    .map(([pubkey, data]) => ({
      pubkey,
      address: pubkeyToAddress(pubkey),
      weight: data.weight,
      postCount: data.posts,
      totalBoots: data.boots,
    }))
    .filter((c) => c.address !== ""); // Exclude invalid pubkeys

  _cachedWeights = result;
  _weightsCachedAt = now;
  return result;
}

/**
 * The default weight source: contribution measured as post activity
 * (sqrt(engagement) × time decay), scanned from the posts table.
 */
export const postActivityWeightSource: WeightSource = {
  name: "post-activity",
  calculate: computePostActivityWeights,
  clearCache() {
    _cachedWeights = null;
    _weightsCachedAt = 0;
  },
};

let _activeSource: WeightSource = postActivityWeightSource;

/** The weight source currently backing `calculateWeights`. */
export function getWeightSource(): WeightSource {
  return _activeSource;
}

/**
 * Swap the weight source. Both the outgoing and incoming source are cache-cleared,
 * so a swap can never serve weights computed under the other strategy.
 *
 * Process-global by design, matching the existing cache. Call it once at a
 * composition point (never mid-request) — the money path reads whatever is
 * registered at boot time.
 */
export function setWeightSource(source: WeightSource): void {
  if (source === _activeSource) return;
  _activeSource.clearCache();
  _activeSource = source;
  _activeSource.clearCache();
}

/** Restore the default post-activity source. Primarily for tests. */
export function resetWeightSource(): void {
  setWeightSource(postActivityWeightSource);
}

/**
 * Calculate contribution weights for all active contributors.
 * Delegates to the registered `WeightSource` — post activity by default.
 */
export function calculateWeights(
  db: import("better-sqlite3").Database,
  launchTs: string = FAIRNESS_CONFIG.launchTs
): ContributorWeight[] {
  return _activeSource.calculate(db, launchTs);
}

/** Clear the active source's cache. Exported for tests only. */
export function _clearWeightsCache(): void {
  _activeSource.clearCache();
}
