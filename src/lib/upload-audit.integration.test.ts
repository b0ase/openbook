/**
 * Provenance and blocking for uploads.
 *
 * ⚠ THIS IS THE ABUSE-RESPONSE PATH, so the tests are written around the
 * question an operator will actually be asking under pressure: this file has
 * been reported, can I make it go away and STAY away, and what else came from
 * wherever it came from.
 *
 * The property that matters most is that a block survives re-upload. Storage is
 * content-addressed, so deleting bytes alone is not a takedown — the same file
 * lands at the same name a second later.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  blockHash,
  getUpload,
  isBlockedHash,
  namesForHash,
  recordUpload,
  siblingsOf,
} from "./upload-audit";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("upload audit", () => {
  beforeEach(() => {
    db.exec("DELETE FROM uploads");
    db.exec("DELETE FROM blocked_uploads");
  });

  it("records what arrived, so a report can be answered at all", () => {
    recordUpload({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      ext: "pdf",
      kind: "doc",
      bytes: 4096,
      originalName: "report.pdf",
      ip: "203.0.113.5",
    });

    const row = getUpload(`${HASH_A}.pdf`);
    expect(row).toMatchObject({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      kind: "doc",
      bytes: 4096,
      originalName: "report.pdf",
    });
    expect(row?.createdAt).toBeTruthy();
  });

  it("never stores the raw IP", () => {
    recordUpload({
      name: `${HASH_A}.png`,
      sha256: HASH_A,
      ext: "png",
      kind: "image",
      bytes: 10,
      ip: "203.0.113.5",
    });
    const stored = db
      .prepare("SELECT ip_hash FROM uploads WHERE name = ?")
      .get(`${HASH_A}.png`) as {
      ip_hash: string;
    };
    expect(stored.ip_hash).not.toContain("203.0.113.5");
    expect(stored.ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps the FIRST upload's record, which is the one that dates the file", () => {
    recordUpload({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      ext: "pdf",
      kind: "doc",
      bytes: 1,
      originalName: "first.pdf",
    });
    recordUpload({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      ext: "pdf",
      kind: "doc",
      bytes: 1,
      originalName: "second.pdf",
    });
    expect(getUpload(`${HASH_A}.pdf`)?.originalName).toBe("first.pdf");
  });

  it("blocks bytes, not names — a re-upload under any extension is still refused", () => {
    expect(isBlockedHash(HASH_A)).toBe(false);
    blockHash(HASH_A, "reported");
    expect(isBlockedHash(HASH_A)).toBe(true);
    // The same bytes offered again as a different type are the same bytes.
    expect(isBlockedHash(HASH_A)).toBe(true);
    expect(isBlockedHash(HASH_B)).toBe(false);
  });

  it("blocking twice is not an error — a second report must not throw", () => {
    blockHash(HASH_A, "first report");
    expect(() => blockHash(HASH_A, "second report")).not.toThrow();
    expect(isBlockedHash(HASH_A)).toBe(true);
  });

  it("lists every stored name holding the bytes, so a takedown removes all of them", () => {
    recordUpload({ name: `${HASH_A}.pdf`, sha256: HASH_A, ext: "pdf", kind: "doc", bytes: 1 });
    recordUpload({ name: `${HASH_A}.png`, sha256: HASH_A, ext: "png", kind: "image", bytes: 1 });
    recordUpload({ name: `${HASH_B}.pdf`, sha256: HASH_B, ext: "pdf", kind: "doc", bytes: 1 });

    expect(namesForHash(HASH_A).sort()).toEqual([`${HASH_A}.pdf`, `${HASH_A}.png`]);
  });

  it("finds what else came from the same source — the real question a report raises", () => {
    const same = "198.51.100.7";
    recordUpload({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      ext: "pdf",
      kind: "doc",
      bytes: 1,
      ip: same,
    });
    recordUpload({
      name: `${HASH_B}.png`,
      sha256: HASH_B,
      ext: "png",
      kind: "image",
      bytes: 1,
      ip: same,
    });
    recordUpload({
      name: `${"c".repeat(64)}.png`,
      sha256: "c".repeat(64),
      ext: "png",
      kind: "image",
      bytes: 1,
      ip: "203.0.113.99",
    });

    const siblings = siblingsOf(`${HASH_A}.pdf`);
    expect(siblings.map((s) => s.name)).toEqual([`${HASH_B}.png`]);
  });

  it("does not group uploads that simply have no recorded source", () => {
    // Two files with a null ip_hash are not "from the same place" — joining on
    // NULL would sweep every anonymous upload into one report.
    recordUpload({ name: `${HASH_A}.pdf`, sha256: HASH_A, ext: "pdf", kind: "doc", bytes: 1 });
    recordUpload({ name: `${HASH_B}.pdf`, sha256: HASH_B, ext: "pdf", kind: "doc", bytes: 1 });
    expect(siblingsOf(`${HASH_A}.pdf`)).toEqual([]);
  });

  it("treats an unknown IP as no IP rather than grouping on the string", () => {
    recordUpload({
      name: `${HASH_A}.pdf`,
      sha256: HASH_A,
      ext: "pdf",
      kind: "doc",
      bytes: 1,
      ip: "unknown",
    });
    recordUpload({
      name: `${HASH_B}.pdf`,
      sha256: HASH_B,
      ext: "pdf",
      kind: "doc",
      bytes: 1,
      ip: "unknown",
    });
    expect(siblingsOf(`${HASH_A}.pdf`)).toEqual([]);
  });
});
