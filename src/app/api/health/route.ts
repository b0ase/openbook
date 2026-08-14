import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { dailySpendStatus } from "@/lib/server-spend-budget";
import { pendingAnchorCount } from "@/services/bsv/anchor-sweep";
import { getBalance, getServerAddress, isServerSpendDisabled } from "@/services/bsv/wallet";
import { FAIRNESS_CONFIG } from "@/services/fairness/config";

export const dynamic = "force-dynamic";

/**
 * Operational health snapshot (Phase 5 observability).
 *
 * Returns 200 when healthy and 503 when a CRITICAL condition is tripped, so a
 * plain status-code uptime monitor (e.g. UptimeRobot, free tier) can email the
 * operator on any non-200 — no Slack/Discord/email dependency in the app. Open
 * the URL directly to eyeball the snapshot.
 *
 * Exposes NO secrets: never the WIF, never the server ADDRESS (only
 * `addressConfigured`), never any per-user identity. `getBalance()` hits
 * WhatsOnChain, so the snapshot is cached 10s and the route is rate-limited.
 */

// Backlog above this = the durable anchor sweep is losing ground (it pulls 20
// per sweep). A persistently high count means posts aren't landing on-chain.
const ORPHAN_BACKLOG_ALERT = 25;
const CACHE_MS = 10_000;

interface HealthSnapshot {
  ok: boolean;
  ts: string;
  issues: string[];
  wallet: {
    balanceSats: number;
    low: boolean;
    spendDisabled: boolean;
    addressConfigured: boolean;
  };
  anchoring: { pendingCount: number; backlogHigh: boolean };
  dailySpend: {
    spentSats: number;
    limitSats: number;
    remainingSats: number;
    ceilingReached: boolean;
  };
}

let cached: { snap: HealthSnapshot; at: number } | null = null;

async function buildSnapshot(): Promise<HealthSnapshot> {
  let balanceSats = 0;
  let balanceReadOk = true;
  try {
    // ⚠ `strict` is load-bearing, not a nicety. Without it `getBalance()`
    // degrades to an empty UTXO set on any WhatsOnChain failure and returns 0
    // WITHOUT throwing — so a transient upstream blip arrives here as a
    // balance of zero with `balanceReadOk` still true, and reports `wallet_low`
    // (critical, pages the operator) instead of `balance_read_failed`
    // (non-critical). That misfired in production on 2026-08-14 against a
    // wallet holding ~667k sats and anchoring posts normally. The failure mode
    // that matters is the second one: an operator taught to ignore this alarm
    // will also ignore a genuinely empty wallet.
    balanceSats = await getBalance({ strict: true });
  } catch {
    balanceReadOk = false; // transient WoC blip — surfaced as an issue, NOT critical
  }

  const spendDisabled = isServerSpendDisabled();
  const addressConfigured = getServerAddress() !== null;
  // Only claim "low" when we actually read the balance (a failed read isn't "low").
  const low = balanceReadOk && balanceSats < FAIRNESS_CONFIG.serverLowBalanceAlertSats;

  const pendingCount = pendingAnchorCount(db);
  const backlogHigh = pendingCount > ORPHAN_BACKLOG_ALERT;

  const spend = dailySpendStatus();
  const ceilingReached = spend.remainingSats <= 0;

  const issues: string[] = [];
  if (low) issues.push("wallet_low");
  if (spendDisabled) issues.push("kill_switch_on");
  if (backlogHigh) issues.push("anchor_backlog_high");
  if (ceilingReached) issues.push("daily_spend_ceiling_reached");
  if (!addressConfigured) issues.push("no_server_wif");
  if (!balanceReadOk) issues.push("balance_read_failed"); // non-critical (WoC blip)

  // "ok" = nothing the operator must act on. A failed balance read is a transient
  // WoC hiccup (not operator-actionable), so it does NOT flip ok→false and won't
  // page the operator on every upstream blip. A truly-down server returns no
  // response at all, which the external monitor catches anyway.
  const critical = low || spendDisabled || backlogHigh || ceilingReached || !addressConfigured;

  return {
    ok: !critical,
    ts: new Date().toISOString(),
    issues,
    wallet: { balanceSats, low, spendDisabled, addressConfigured },
    anchoring: { pendingCount, backlogHigh },
    dailySpend: {
      spentSats: spend.spentSats,
      limitSats: spend.limitSats,
      remainingSats: spend.remainingSats,
      ceilingReached,
    },
  };
}

export async function GET(request: NextRequest) {
  // Optional token gate. Unset = open (still cached + rate-limited).
  const token = process.env.HEALTH_TOKEN?.trim();
  if (token) {
    const provided =
      request.nextUrl.searchParams.get("token") ||
      request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "")
        .trim();
    if (provided !== token) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Rate-limit — a cache miss reads WhatsOnChain.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`health:${ip}`, { limit: 30, windowMs: 60_000 }).success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    cached = { snap: await buildSnapshot(), at: now };
  }

  // 200 healthy / 503 critical — a status-code uptime monitor emails on non-200.
  return NextResponse.json(cached.snap, { status: cached.snap.ok ? 200 : 503 });
}
