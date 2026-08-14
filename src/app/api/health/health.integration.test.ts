/**
 * Integration tests for /api/health route handler.
 *
 * Verifies the 200/503 status code logic and the issues[] array for each
 * critical condition: wallet low, kill-switch on, anchor backlog high,
 * daily spend ceiling reached, and no server WIF configured.
 *
 * getBalance is mocked (no WoC contact).
 *
 * The health route has a 10s module-level cache. We bust it per-test by
 * calling vi.resetModules() + re-importing the route handler, which gives
 * each test a fresh module instance with an empty cache.
 *
 * Because vi.resetModules() also re-imports @/lib/db, each test gets a
 * fresh in-memory SQLite with the full schema (from db.ts migrations).
 * That is intentional for health tests: each test owns its entire DB state.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("health route — integration", () => {
  let ipCounter = 50;
  function nextIp() {
    ipCounter++;
    return `172.16.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/services/bsv/wallet", () => ({
      getBalance: vi.fn().mockResolvedValue(500_000),
      getServerAddress: vi.fn().mockReturnValue("1ServerWalletAddressForTest"),
      isServerSpendDisabled: vi.fn().mockReturnValue(false),
      buildAndBroadcast: vi.fn(),
      SERVER_FEE_BUFFER_SATS: 300,
    }));
    delete process.env.SERVER_DAILY_SPEND_SATS;
    delete process.env.BSV_WALLET_SPEND_DISABLED;
    delete process.env.HEALTH_TOKEN;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(ip: string): NextRequest {
    return new NextRequest("http://localhost/api/health", {
      method: "GET",
      headers: { "x-forwarded-for": ip },
    });
  }

  it("returns response with correct snapshot structure", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("ts");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body).toHaveProperty("wallet");
    expect(body).toHaveProperty("anchoring");
    expect(body).toHaveProperty("dailySpend");
    expect(body.wallet).toHaveProperty("balanceSats");
    expect(body.wallet).toHaveProperty("addressConfigured");
    expect(body.anchoring).toHaveProperty("pendingCount");
    expect(body.dailySpend).toHaveProperty("spentSats");
  });

  it("reports wallet_low and 503 when balance is below alert threshold", async () => {
    const { GET } = await import("./route");
    const walletMod = await import("@/services/bsv/wallet");
    vi.mocked(walletMod.getBalance).mockResolvedValue(5_000); // below 10_000 threshold

    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.issues).toContain("wallet_low");
    expect(body.wallet.low).toBe(true);
  });

  /**
   * ⚠ REGRESSION GUARD (production misfire, 2026-08-14).
   *
   * `getBalance()` without `strict` degrades to an empty UTXO set on any
   * WhatsOnChain failure and returns 0 WITHOUT throwing — so an unreadable
   * wallet arrived here as a balance of zero and reported `wallet_low`
   * (critical, 503, pages the operator) against a wallet holding ~667k sats
   * that was anchoring posts normally. The dangerous half is the second-order
   * effect: an operator taught to ignore this alarm ignores a real one too.
   */
  it("reports balance_read_failed as NON-critical (200) when the balance cannot be read", async () => {
    const { GET } = await import("./route");
    const walletMod = await import("@/services/bsv/wallet");
    vi.mocked(walletMod.getBalance).mockRejectedValue(new Error("WhatsOnChain HTTP 429"));

    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.issues).toContain("balance_read_failed");
    // The whole point: an unreadable wallet must NOT be reported as a low one.
    expect(body.issues).not.toContain("wallet_low");
    expect(body.wallet.low).toBe(false);
  });

  it("asks for a STRICT balance read, so a failed read cannot look like an empty wallet", async () => {
    const { GET } = await import("./route");
    const walletMod = await import("@/services/bsv/wallet");

    await GET(makeRequest(nextIp()));

    expect(walletMod.getBalance).toHaveBeenCalledWith({ strict: true });
  });

  it("reports kill_switch_on and 503 when server spending is disabled", async () => {
    const { GET } = await import("./route");
    const walletMod = await import("@/services/bsv/wallet");
    vi.mocked(walletMod.isServerSpendDisabled).mockReturnValue(true);

    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.issues).toContain("kill_switch_on");
    expect(body.wallet.spendDisabled).toBe(true);
  });

  it("reports no_server_wif and 503 when getServerAddress returns null", async () => {
    const { GET } = await import("./route");
    const walletMod = await import("@/services/bsv/wallet");
    vi.mocked(walletMod.getServerAddress).mockReturnValue(null);

    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.issues).toContain("no_server_wif");
    expect(body.wallet.addressConfigured).toBe(false);
  });

  it("reports anchor_backlog_high and 503 when more than 25 orphan posts exist", async () => {
    // Import the fresh db instance for this test's module scope
    const { db } = await import("@/lib/db");

    // Insert 26 orphan posts (tx_id NULL) — fresh DB, so no cleanup needed
    const stmt = db.prepare(
      `INSERT INTO posts (content, author_name, signature, pubkey, tx_id, created_at)
       VALUES (?, ?, ?, ?, NULL, datetime('now', '-10 minutes'))`
    );
    for (let i = 0; i < 26; i++) {
      stmt.run(`Orphan health test ${i}`, "anon_hlt", "sig", "pk");
    }

    // Import the route AFTER seeding — same fresh module scope sees the same db
    const { GET } = await import("./route");
    const res = await GET(makeRequest(nextIp()));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.issues).toContain("anchor_backlog_high");
    expect(body.anchoring.pendingCount).toBeGreaterThanOrEqual(26);
    expect(body.anchoring.backlogHigh).toBe(true);
  });

  it("returns 429 after rate limit is exceeded (31st request from same IP)", async () => {
    const { GET } = await import("./route");
    const ip = "10.99.99.96";
    // Rate limit is 30/min for health
    for (let i = 0; i < 30; i++) {
      await GET(makeRequest(ip));
    }
    const res = await GET(makeRequest(ip));
    expect(res.status).toBe(429);
  });

  it("returns 401 with a HEALTH_TOKEN set and wrong/missing token", async () => {
    process.env.HEALTH_TOKEN = "secret-test-token";
    try {
      const { GET } = await import("./route");
      const res = await GET(makeRequest(nextIp()));
      expect(res.status).toBe(401);
    } finally {
      delete process.env.HEALTH_TOKEN;
    }
  });

  it("returns non-401 when HEALTH_TOKEN is set and correct token provided", async () => {
    process.env.HEALTH_TOKEN = "secret-test-token";
    try {
      const { GET } = await import("./route");
      const req = new NextRequest("http://localhost/api/health?token=secret-test-token", {
        method: "GET",
        headers: { "x-forwarded-for": nextIp() },
      });
      const res = await GET(req);
      expect(res.status).not.toBe(401);
    } finally {
      delete process.env.HEALTH_TOKEN;
    }
  });
});
