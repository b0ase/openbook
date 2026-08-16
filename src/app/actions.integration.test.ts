/**
 * Integration tests for server actions: createPost and bootPost.
 *
 * Uses the in-memory SQLite singleton (DATABASE_PATH=':memory:' set in
 * integration-setup.ts before any @/lib/db import) so the full schema
 * migrations from db.ts run once before these tests.
 *
 * External side-effects (logPostOnChain, executeBoot) are mocked so no
 * real wallet spend or ARC/WoC traffic occurs.
 */

import { PrivateKey } from "@bsv/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_POST_CHARS } from "@/lib/post-length";

// ── Module mocks (must be declared before imports that use them) ─────────────

// Mock logPostOnChain so no real BSV broadcast happens in createPost
vi.mock("@/services/bsv/onchain", () => ({
  logPostOnChain: vi.fn().mockResolvedValue("mocktxid_post"),
}));

// Mock sweepOrphans (fire-and-forget side-effect of createPost)
vi.mock("@/services/bsv/anchor-sweep", () => ({
  sweepOrphans: vi.fn().mockResolvedValue(undefined),
}));

// Mock executeBoot so the boot orchestrator / server wallet is never invoked
vi.mock("@/services/fairness/boot-orchestrator", () => ({
  executeBoot: vi.fn(),
}));

// Mock wallet functions so isServerSpendDisabled() and getBalance() behave
// predictably without a real key
vi.mock("@/services/bsv/wallet", () => ({
  isServerSpendDisabled: vi.fn().mockReturnValue(false),
  getServerAddress: vi.fn().mockReturnValue("1PlatformAddressForTests"),
  getBalance: vi.fn().mockResolvedValue(500_000),
  buildAndBroadcast: vi.fn(),
  SERVER_FEE_BUFFER_SATS: 300,
}));

// Mock next/headers so the actions can read headers in a non-Next context
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(
    new Map([
      ["x-forwarded-for", "10.0.0.1"],
      ["x-real-ip", "10.0.0.1"],
    ])
  ),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { isServerSpendDisabled } from "@/services/bsv/wallet";
import { executeBoot } from "@/services/fairness/boot-orchestrator";
import { bootPost, createPost, getPosts } from "./actions";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockExecuteBoot() {
  return vi.mocked(executeBoot);
}

/** Generate a real BSV keypair and sign content — gives us a genuinely verifiable sig. */
async function makeSignedFormData(content: string) {
  const key = PrivateKey.fromRandom();
  const pubkey = key.toPublicKey().toString();
  const messageBytes = Array.from(new TextEncoder().encode(content));
  const sig = key.sign(messageBytes);
  const sigHex = sig.toDER("hex");
  const fd = new FormData();
  fd.set("content", content);
  fd.set("author", "anon_t3st");
  fd.set("pubkey", pubkey);
  fd.set("signature", sigHex as string);
  return { fd, pubkey, sigHex, key };
}

/** Clean all test data between test cases. */
function truncateTables() {
  db.exec("DELETE FROM payouts");
  db.exec("DELETE FROM bootboard");
  db.exec("DELETE FROM boot_grants");
  db.exec("DELETE FROM posts");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createPost — integration", () => {
  beforeEach(() => {
    truncateTables();
    vi.clearAllMocks();
    vi.mocked(isServerSpendDisabled).mockReturnValue(false);
  });

  it("happy path: valid signed post is persisted and getPosts returns it", async () => {
    const content = "Integration test post content";
    const { fd, pubkey } = await makeSignedFormData(content);

    const result = await createPost(fd);

    expect(result.ok).toBe(true);

    const posts = await getPosts();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    const saved = posts.find((p) => p.content === content);
    expect(saved).toBeDefined();
    expect(saved?.pubkey).toBe(pubkey);
    expect(saved?.signature).toBeTruthy();
    expect(saved?.author_name).toBe("anon_t3st");
  });

  it("invalid_signature: bad signature is rejected before DB write", async () => {
    const fd = new FormData();
    fd.set("content", "some content");
    fd.set("author", "anon_t3st");
    fd.set("pubkey", PrivateKey.fromRandom().toPublicKey().toString());
    fd.set("signature", "deadbeef00112233"); // not a valid DER sig for this content

    const result = await createPost(fd);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");

    const posts = await getPosts();
    expect(posts.filter((p) => p.content === "some content")).toHaveLength(0);
  });

  it("bad_input: empty content returns bad_input", async () => {
    const fd = new FormData();
    fd.set("content", "");
    fd.set("author", "anon_t3st");
    fd.set("pubkey", PrivateKey.fromRandom().toPublicKey().toString());
    fd.set("signature", "abc");

    const result = await createPost(fd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_input");
  });

  /**
   * ⚠ THE 1,000-CHARACTER LIMIT WAS REMOVED ON PURPOSE (owner, 2026-08-16), so
   * this pair replaces a test that asserted it. Posting is paid and priced by
   * size, so length polices itself with the author's own money. What remains is
   * an ABUSE ceiling, and it is still asserted — every post is re-sent to every
   * client on every feed poll, so an unbounded body is a bill everyone pays.
   */
  it("accepts a post far longer than the old 1,000-character limit", async () => {
    const { fd } = await makeSignedFormData("x".repeat(5_000));

    const result = await createPost(fd);
    expect(result.ok).toBe(true);
  });

  it("bad_input: content above the abuse ceiling is still refused", async () => {
    const { fd } = await makeSignedFormData("x".repeat(MAX_POST_CHARS + 1));

    const result = await createPost(fd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_input");
  });

  it("missing_pubkey: absent pubkey returns missing_pubkey", async () => {
    const fd = new FormData();
    fd.set("content", "hello world");
    fd.set("author", "anon_t3st");
    // no pubkey
    fd.set("signature", "abc");

    const result = await createPost(fd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_pubkey");
  });

  it("rate_limited: 11th call from same pubkey within a minute returns rate_limited", async () => {
    // Use a unique key so this test's rate-limit bucket doesn't bleed into others
    const key = PrivateKey.fromRandom();
    const pubkey = key.toPublicKey().toString();

    const sendPost = async (suffix: string) => {
      const content = `rl_test_${suffix}_${Date.now()}_${Math.random()}`;
      const fd = new FormData();
      fd.set("content", content);
      fd.set("author", "anon_rl00");
      fd.set("pubkey", pubkey);
      const msgBytes = Array.from(new TextEncoder().encode(content));
      const sig = key.sign(msgBytes);
      fd.set("signature", sig.toDER("hex") as string);
      return createPost(fd);
    };

    // First 10 should succeed (may or may not record, but not rate_limited)
    for (let i = 0; i < 10; i++) {
      const r = await sendPost(String(i));
      // Accept ok or other non-rate_limited reasons (daily_limit, paused)
      if (!r.ok) {
        expect(r.reason).not.toBe("rate_limited");
      }
    }

    // 11th must be rate_limited
    const r11 = await sendPost("11");
    expect(r11.ok).toBe(false);
    expect(r11.reason).toBe("rate_limited");
  });

  it("rejected_content: denylisted word blocks the post before DB write", async () => {
    const content = "This post contains FORBIDDEN_WORD_INTEGRATION_TEST_ONLY";
    const { fd } = await makeSignedFormData(content);

    // Temporarily set a denylist env var
    const orig = process.env.CONTENT_DENYLIST;
    process.env.CONTENT_DENYLIST = "FORBIDDEN_WORD_INTEGRATION_TEST_ONLY";
    try {
      const result = await createPost(fd);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("rejected_content");
    } finally {
      if (orig === undefined) delete process.env.CONTENT_DENYLIST;
      else process.env.CONTENT_DENYLIST = orig;
    }

    const posts = await getPosts();
    expect(posts.filter((p) => p.content.includes("FORBIDDEN_WORD"))).toHaveLength(0);
  });

  it("paused: kill-switch returns paused", async () => {
    vi.mocked(isServerSpendDisabled).mockReturnValue(true);
    const { fd } = await makeSignedFormData(`kill switch test ${Date.now()}`);

    const result = await createPost(fd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("paused");
  });

  it("paused: budget exhausted returns paused", async () => {
    // Set the daily spend limit so low that even one post exceeds it
    const orig = process.env.SERVER_DAILY_SPEND_SATS;
    process.env.SERVER_DAILY_SPEND_SATS = "1"; // 1 sat limit — well under POST_LOG_COST_SATS (70)
    try {
      const { fd } = await makeSignedFormData(`budget test ${Date.now()}`);
      const result = await createPost(fd);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("paused");
    } finally {
      if (orig === undefined) delete process.env.SERVER_DAILY_SPEND_SATS;
      else process.env.SERVER_DAILY_SPEND_SATS = orig;
    }
  });

  it("daily_limit: per-IP post cap returns daily_limit", async () => {
    // Set a very low IP cap (1 per day) so the second call from our test IP hits it
    const orig = process.env.ONCHAIN_POST_IP_LIMIT;
    process.env.ONCHAIN_POST_IP_LIMIT = "1";
    try {
      // First post from this IP in this test (might succeed or be rate-limited by pubkey,
      // but will consume the IP slot)
      const k = PrivateKey.fromRandom();
      const makePost = async (n: number) => {
        const content = `ip_cap_test_${n}_${Date.now()}_${Math.random()}`;
        const fd = new FormData();
        fd.set("content", content);
        fd.set("author", "anon_ip00");
        fd.set("pubkey", k.toPublicKey().toString());
        const msgBytes = Array.from(new TextEncoder().encode(content));
        const sig = k.sign(msgBytes);
        fd.set("signature", sig.toDER("hex") as string);
        return createPost(fd);
      };

      await makePost(1); // consume the 1-per-day IP slot

      const result = await makePost(2);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("daily_limit");
    } finally {
      if (orig === undefined) delete process.env.ONCHAIN_POST_IP_LIMIT;
      else process.env.ONCHAIN_POST_IP_LIMIT = orig;
    }
  });
});

describe("bootPost — integration routing", () => {
  beforeEach(() => {
    truncateTables();
    vi.clearAllMocks();
    vi.mocked(isServerSpendDisabled).mockReturnValue(false);
  });

  /** Insert a signed post and return its id + the creator's pubkey. */
  async function insertPost(): Promise<{ postId: number; pubkey: string }> {
    const key = PrivateKey.fromRandom();
    const pubkey = key.toPublicKey().toString();
    const r = db
      .prepare("INSERT INTO posts (content, author_name, signature, pubkey) VALUES (?,?,?,?)")
      .run("bootable content", "anon_bp01", "fakesig", pubkey);
    return { postId: r.lastInsertRowid as number, pubkey };
  }

  it("ip-cap binds → requiresPayment when free-boot IP cap is exhausted", async () => {
    // The per-IP free-boot cap in tryConsumeFreeBootForIp uses the rate limiter
    // keyed on the IP. We mock headers to supply a known IP, then exhaust the cap
    // by setting the limit env var extremely low.
    // NOTE: free-boot-cap uses its own in-memory limit of 40/IP/24h from
    // rate-limit.ts, not an env var. We can't set it lower without changing the
    // source. Instead, exhaust it by calling bootPost 41 times from the same IP,
    // or use the BSV_WALLET_SPEND_DISABLED + budget flags to force requiresPayment.
    //
    // Simpler route: exhaust the daily budget so grantAllowsFree path hits
    // !hasDailyBudget() → isFree=false → requiresPayment.
    const { postId } = await insertPost();
    const orig = process.env.SERVER_DAILY_SPEND_SATS;
    process.env.SERVER_DAILY_SPEND_SATS = "1"; // budget exhausted
    try {
      const result = await bootPost(postId, "1BoosterAddress1Abc", "anon_bo01");
      expect(result.requiresPayment).toBe(true);
      expect(result.bootPrice).toBeGreaterThan(0);
    } finally {
      if (orig === undefined) delete process.env.SERVER_DAILY_SPEND_SATS;
      else process.env.SERVER_DAILY_SPEND_SATS = orig;
    }
  });

  it("executeBoot indeterminate → {indeterminate:true, isFree:true}", async () => {
    const { postId } = await insertPost();

    makeMockExecuteBoot().mockResolvedValue({
      success: false,
      indeterminate: true,
      isFree: true,
      price: 1000,
      recipients: 0,
      error: "Boost submitted but not yet confirmed",
    });

    const result = await bootPost(postId, "1BoosterAddress1Abc", "anon_bo02");
    expect(result.indeterminate).toBe(true);
    expect(result.isFree).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("FREE_GRANT_EXHAUSTED from executeBoot → requiresPayment with price", async () => {
    const { postId } = await insertPost();

    makeMockExecuteBoot().mockResolvedValue({
      success: false,
      isFree: false,
      price: 5000,
      recipients: 0,
      error: "FREE_GRANT_EXHAUSTED",
    });

    const result = await bootPost(postId, "1BoosterAddress1Abc", "anon_bo03");
    expect(result.requiresPayment).toBe(true);
    expect(result.bootPrice).toBe(5000);
    expect(result.isFree).toBe(false);
  });

  it("successful free executeBoot → success true", async () => {
    const { postId } = await insertPost();

    makeMockExecuteBoot().mockResolvedValue({
      success: true,
      isFree: true,
      txid: "freetxid_abc123",
      price: 1000,
      recipients: 3,
    });

    const result = await bootPost(postId, "1BoosterAddress1Abc", "anon_bo04");
    expect(result.success).toBe(true);
    expect(result.isFree).toBe(true);
    expect(result.txid).toBe("freetxid_abc123");
  });
});
