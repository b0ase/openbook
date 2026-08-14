/**
 * Link-preview backfill.
 *
 * The bug this fixes: unfurling only ever ran inside `createPost`, so seeded and
 * imported posts — which are written straight into SQLite — had no previews no
 * matter how many links they contained. These tests pin the two properties that
 * make the backfill safe to run against hundreds of historical rows: it drains
 * cache hits freely, and it makes AT MOST ONE outbound request per sweep.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUnfurl = vi.fn();
vi.mock("./link-unfurl", () => ({
  unfurl: (...args: unknown[]) => mockUnfurl(...args),
}));

import { db } from "@/lib/db";
import { pendingPreviewCount, sweepPreviews } from "./link-preview-sweep";

function insertPost(content: string): number {
  const r = db
    .prepare(
      "INSERT INTO posts (content, author_name, signature, pubkey, created_at) VALUES (?,?,?,?,datetime('now'))"
    )
    .run(content, "anon_seed", "sig", "pk");
  return r.lastInsertRowid as number;
}

const okResult = (url: string) => ({
  ok: true,
  url,
  data: { title: "A Title", description: "desc", image: null, siteName: "Site" },
});

beforeEach(() => {
  db.exec("DELETE FROM posts");
  db.exec("DELETE FROM link_previews");
  mockUnfurl.mockReset();
  // Module-level backoff maps persist between tests; fresh post ids each time
  // (AUTOINCREMENT) keep them from interfering.
});

describe("backfilling historical posts", () => {
  it("unfurls a seeded post that never went through createPost", async () => {
    const id = insertPost("look at https://example.com/a");
    mockUnfurl.mockResolvedValue(okResult("https://example.com/a"));

    await sweepPreviews(db);

    const row = db.prepare("SELECT preview_hash FROM posts WHERE id = ?").get(id) as {
      preview_hash: string | null;
    };
    expect(row.preview_hash).not.toBeNull();
    expect(mockUnfurl).toHaveBeenCalledTimes(1);
  });

  it("ignores posts with no link", async () => {
    insertPost("no links here at all");
    await sweepPreviews(db);
    expect(mockUnfurl).not.toHaveBeenCalled();
  });

  it("leaves an already-previewed post alone", async () => {
    const id = insertPost("https://example.com/b");
    mockUnfurl.mockResolvedValue(okResult("https://example.com/b"));
    await sweepPreviews(db);
    expect(mockUnfurl).toHaveBeenCalledTimes(1);

    mockUnfurl.mockClear();
    await sweepPreviews(db); // second pass
    expect(mockUnfurl).not.toHaveBeenCalled();
    expect(
      (
        db.prepare("SELECT preview_hash FROM posts WHERE id = ?").get(id) as {
          preview_hash: string;
        }
      ).preview_hash
    ).toBeTruthy();
  });
});

describe("outbound request budget", () => {
  it("makes AT MOST ONE network fetch per sweep", async () => {
    // The property that stops a backfill over historical posts turning into an
    // accidental crawler against other people's servers.
    for (let i = 0; i < 5; i++) insertPost(`https://example.com/distinct-${i}`);
    mockUnfurl.mockImplementation((url: string) => Promise.resolve(okResult(url)));

    await sweepPreviews(db);

    expect(mockUnfurl).toHaveBeenCalledTimes(1);
  });

  it("drains cache hits for free, without extra fetches", async () => {
    // Same URL on many posts: one fetch, then every other post attaches from the
    // store at no network cost.
    for (let i = 0; i < 4; i++) insertPost(`post ${i}: https://example.com/shared`);
    mockUnfurl.mockResolvedValue(okResult("https://example.com/shared"));

    await sweepPreviews(db); // fetches once, then attaches the rest from cache

    expect(mockUnfurl).toHaveBeenCalledTimes(1);
    expect(pendingPreviewCount(db)).toBe(0);
  });
});

describe("failures are recorded, not retried forever", () => {
  it("stores a failed unfurl so the URL is not re-fetched", async () => {
    const id = insertPost("https://example.com/dead");
    mockUnfurl.mockResolvedValue({
      ok: false,
      url: "https://example.com/dead",
      reason: "bad_status",
    });

    await sweepPreviews(db);
    const row = db.prepare("SELECT preview_hash FROM posts WHERE id = ?").get(id) as {
      preview_hash: string | null;
    };
    expect(row.preview_hash).not.toBeNull(); // the failure IS the recorded answer

    mockUnfurl.mockClear();
    await sweepPreviews(db);
    expect(mockUnfurl).not.toHaveBeenCalled();
  });
});

describe("pendingPreviewCount", () => {
  it("counts only posts with a link and no preview", async () => {
    insertPost("plain text");
    insertPost("https://example.com/one");
    insertPost("https://example.com/two");
    expect(pendingPreviewCount(db)).toBe(2);
  });
});
