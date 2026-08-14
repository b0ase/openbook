/**
 * Integration test setup — runs BEFORE any module import.
 *
 * Sets DATABASE_PATH=':memory:' so the db singleton opens an in-memory SQLite
 * database (not local.db on disk) with the full schema from db.ts migrations.
 *
 * Must run before any @/lib/db import, which is guaranteed by listing this
 * as a setupFile in the vitest integration project.
 */

// Point the db singleton at an in-memory database for every integration test file.
process.env.DATABASE_PATH = ":memory:";

// Ensure server-wallet spending is disabled by default in integration tests
// (no real BSV transactions should ever leave this test environment).
process.env.BSV_WALLET_SPEND_DISABLED = "true";

// Prevent real WIF loading in tests
delete process.env.BSV_SERVER_WIF;

/**
 * Start post ids ABOVE the fork point, so test posts are OpenBook-era.
 *
 * ⚠ WITHOUT THIS, EVERY INTEGRATION TEST POSTS INTO THE INHERITED ERA. Feed reads
 * default to `id > FORK_POINT_ID` (posts at or below it were written on OpenCook
 * and are hidden unless explicitly asked for). A fresh in-memory database starts
 * at id 1, so a post created by a test landed in the hidden range and `getPosts`
 * correctly returned nothing — which reads as "the feed is broken" rather than
 * "the fixture is unrealistic".
 *
 * Bumping the sequence makes the test database resemble production, where every
 * new post is necessarily past the fork. Tests that want to exercise the
 * inherited era should insert low ids explicitly rather than rely on the default.
 *
 * `DELETE FROM posts` does not reset `sqlite_sequence`, so this survives the
 * per-test cleanup every suite does in `beforeEach`.
 */
const { db } = await import("@/lib/db");
const { FORK_POINT_ID } = await import("@/lib/fork-point");
db.exec(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES ('posts', ${FORK_POINT_ID})`);

// Makes this file a module so the top-level awaits above are legal TypeScript.
export {};
