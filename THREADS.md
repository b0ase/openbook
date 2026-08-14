# Threading

> Build spec for thread structure on `posts` — the prerequisite for the token tree in
> [TOKENS.md](TOKENS.md). A token attaches to a thread root, so there must be thread roots.
>
> **Status: spec, not built.** Nothing here is implemented.
>
> Last updated: 2026-08-14

## Why this comes first

The token model is: anyone starts a thread, marks it with a `$ticker`, mints it, and the
parent token takes a stake in the child. Every part of that assumes a thread. `posts` today
is flat:

```sql
posts (id, content, author_name, signature, pubkey, tx_id, created_at)
```

No `parent_id`, no reply structure. The feed is a linear list ordered by `id`. There is
nothing for a ticker to attach to.

## Schema

Two nullable columns, added via the existing `addColumnIfMissing` helper in `db.ts` (it
already handles the parallel-`next build` race that broke the Railway deploy — reuse it,
do not hand-roll an `ALTER TABLE`).

```ts
// A reply's immediate parent. NULL = this post is a thread root.
addColumnIfMissing("posts", "parent_id", "parent_id INTEGER REFERENCES posts(id)");

// The thread this post belongs to. Set to the post's OWN id for roots, so a
// thread's contents are always exactly `WHERE root_id = ?` — one indexed scan,
// no recursive CTE. Token allocation runs this query on every mint.
addColumnIfMissing("posts", "root_id", "root_id INTEGER REFERENCES posts(id)");
```

**Why `root_id` as well as `parent_id`.** `parent_id` alone gives you the tree but makes
"every post in this thread" a `WITH RECURSIVE` walk. That query is on the token-allocation
path and would run per mint and per payout. Denormalising the root makes it a single
indexed lookup. The cost is one column and one write-time rule.

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_posts_parent_id ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_root_id   ON posts(root_id);
```

**Two, not three — corrected by measurement during the build.** This spec originally
called for a partial `idx_posts_roots ON posts(id DESC) WHERE parent_id IS NULL` to serve
the root feed. `EXPLAIN QUERY PLAN` over 50 roots + 2,000 replies shows SQLite never
chooses it:

```
WITH BOTH:     SEARCH posts USING INDEX idx_posts_parent_id (parent_id=?)
PARTIAL ONLY:  SCAN posts USING INDEX idx_posts_roots
```

`id` is `INTEGER PRIMARY KEY`, i.e. the rowid, so an index on `(parent_id)` physically
stores `(parent_id, rowid)` pairs. Walking its `parent_id IS NULL` span backwards yields
`ORDER BY id DESC` directly — no sort step, no temp b-tree. The partial index would add
write cost on every insert and buy nothing. Dropped, with a test asserting it stays
dropped.

### The existing 2,006 posts need no backfill

Both columns default to NULL, so every genesis-seed and pre-launch post reads as a thread
root — which is correct, they are. `root_id` stays NULL for them; see the compatibility
note under *Write path* for why that is safe and how to normalise it lazily if wanted.

## Write path

`createPost` takes an optional `parentId`. In one transaction:

1. If `parentId` is given, load the parent. **Reject if it does not exist** — a reply to a
   nonexistent post would create an orphan the feed can never render.
2. `root_id = parent.root_id ?? parent.id`. This is what keeps arbitrary nesting depth
   cheap to query: a reply five levels down still carries the same `root_id` as the
   thread's first post.
3. Insert with `parent_id` and `root_id`.
4. For a root post (`parentId` absent), `root_id` is not known until the row exists —
   `UPDATE posts SET root_id = id WHERE id = ?` immediately after insert, inside the same
   transaction.

**Compatibility rule for the old rows:** treat `root_id IS NULL` as self-rooted. Any query
that aggregates a thread must therefore read
`WHERE root_id = ? OR (id = ? AND root_id IS NULL)`, or the genesis posts vanish from their
own threads. The cleaner alternative is a one-shot backfill
(`UPDATE posts SET root_id = id WHERE root_id IS NULL AND parent_id IS NULL`) run once in
`db.ts` behind an `addColumnIfMissing` return value, which then lets every read use the
plain `WHERE root_id = ?`. **Recommend the backfill** — 2,006 rows, one statement, and it
removes a footgun from every future query.

### Depth

Arbitrary depth costs nothing to store or query given `root_id`, but it costs the UI. Two
options:

- **Cap at depth 1** (all replies point at the root). Simplest; the thread is a flat list.
  Sufficient for the token model, where the thread is the unit and the shape inside it is
  not economically meaningful.
- **Allow arbitrary depth**, render flat anyway, keep `parent_id` for a future
  "replying to" chip.

**Recommend arbitrary depth, rendered flat.** It costs one extra column read and preserves
the option; capping is a decision you cannot reverse without losing information.

## Read path — every query, and whether it changes

The feed shows **thread roots only**. Replies are read inside a thread view. This is what
makes a thread the unit a ticker attaches to.

| function | change |
|---|---|
| `getPosts()` / `getPosts(beforeId)` | add `WHERE p.parent_id IS NULL` (and `AND` in the `beforeId` variant) |
| `getNewPosts(sinceId)` | add the filter — **a new reply must not appear in the root feed** |
| `getOldestPosts()` | add the filter |
| `getForwardPosts(afterId)` | add the filter |
| `getOlderPosts(beforeId)` | none — delegates to `getPosts(beforeId)`, inherits it |
| `getUpdatedPosts(knownIds)` | none — takes an explicit id list |
| `getPostCounts(ids)` | none — explicit id list (but see *Boot counts* below) |
| `getBootboard()` | none — boots target `posts.id`, unchanged |
| **new** `getThread(rootId)` | `WHERE root_id = ? ORDER BY id ASC` |

### Cursor pagination survives the filter

This is the part most likely to be assumed broken and is not. `Feed.tsx` pages on
`id < before` (LIVE scroll-up) and `id > after` (ORIGIN read-forward). **Filtering rows out
does not break a cursor as long as the cursor column stays monotonic and unique**, which
`id` does. `LIMIT 100` simply returns 100 roots spanning a wider id range.

What *does* change: id gaps grow, so any code inferring "how many posts exist" from an id
delta becomes wrong. Nothing does this today — worth not introducing.

### Feed.tsx invariants to re-verify

Threading touches four things that are individually subtle and were each hard-won:

1. **`liveHasMore` → founding-block render.** `PostList` renders `<Manifesto>` at top once
   `liveHasMore` is false. With the filter, "reached post #1" means *reached the oldest
   root*, which may not be `id = 1` if post #1 ever becomes a reply. It cannot today
   (genesis posts are all roots), but state the invariant rather than rely on it.
2. **Bottom-relative scroll anchoring on prepend.** `prependPrevHeightRef` →
   `el.scrollTop += scrollHeight − before`. Unaffected by the filter; it measures pixels,
   not rows.
3. **`oldestServerId` bounds the unread observer.** Still correct — it is a watermark, and
   watermarks do not care about gaps.
4. **`opencook_last_read_id`.** Also a watermark. A reply incrementing the id sequence
   without appearing in the feed is harmless.

### Boot counts — a real decision, not a mechanical change

`boot_count` is currently `COUNT(*) FROM bootboard WHERE post_id = p.id`. With threads:

- **Per-post** (no change): booting a reply boosts that reply.
- **Thread-aggregated**: a root's `boot_count` sums every boot in its thread.

Thread-aggregated is almost certainly what the token model wants — a thread's economic
signal should include its replies — but it changes `weights.ts` engagement scoring and the
`bootboard` spotlight semantics simultaneously. **Recommend shipping per-post first** and
treating thread aggregation as a separate change with its own tests, so a feed regression
and a payout regression cannot arrive in the same commit.

## What deliberately does not change

- **`weights.ts` needs no edit.** Replies are posts with a `pubkey`, so they earn
  contribution weight automatically under the existing query. That is the correct default —
  a reply is a contribution — and it is worth stating so nobody "fixes" it.
- **`bootboard`, `boot_grants`, `payouts`** — all key on `posts.id`, which still exists and
  still means the same thing.
- **The money path.** No file under `src/services/fairness/` changes for threading.

## On-chain

The post OP_RETURN should carry the parent so the thread graph is reconstructible from the
chain rather than only from SQLite — the audit trail is the point. In
`onchain.ts`'s body:

```ts
{ ...existing, parent: parentId ?? null }
```

Per the reader contract in `src/lib/onchain-record.ts`: **additive optional fields do not
bump `v`.** Readers ignore unknown fields, so existing consumers are unaffected and this
stays `v: 1`.

## Build order

1. Migration + indexes + backfill (`db.ts`).
2. `createPost(parentId?)` with parent-exists validation and `root_id` resolution.
3. Read-query filters + `getThread`.
4. UI: thread view, reply composer, root-feed unchanged.
5. On-chain `parent` field.

Steps 1–3 are independently testable against an in-memory SQLite database using the
existing `weights.test.ts` fixture pattern, before any UI exists.

## Open question carried from TOKENS.md

**Does ordinary posting become paid?** The note that prompted this spec said *"if this is
pay to post then users should also receive tokens in return"* — which is right as a
principle. But posting is free today and the server covers the ~$0.0005 on-chain cost, and
DIRECTION.md's entire onboarding claim rests on that: *"no wallet downloads, no seed
phrases, no 'buy crypto first'"*, targeting ~15% conversion against an industry ~0.3%.

Paying to **mint a ticker** is a founding act and a natural fee. Paying to **post** is a
different thing and would end zero-friction onboarding. Worth separating explicitly before
either is built.
