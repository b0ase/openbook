import { db } from "./db";
import { canonicalTicker, isValidTicker } from "./ticker";

/**
 * A word pays for its own thinking.
 *
 * ⚠ THE PROBLEM THIS EXISTS TO CLOSE. Answering an invocation is paid for by the
 * person who invoked it. **Re-deriving a definition is paid for by nobody.** It
 * was the one operation whose cost scaled with the platform's own tick rate
 * rather than with demand — so raising `AGENT_TICK_INTERVAL_MS`, or deriving
 * more than one word per beat, raised the bill with no revenue attached to it.
 * That is the only line item in the agent design that could run away.
 *
 * The fix follows the design rather than fighting it: **a word re-derives out of
 * its own balance**, funded by the invocation fees it has already collected.
 * Words that get used can afford to think about themselves; words that do not,
 * do not. Platform exposure is then bounded by the founding grant alone.
 *
 * ⚠ THIS IS A LEDGER, NOT A WALLET. Per-ticker addresses do not exist yet (HD
 * derivation is designed, not built — see TOKENS.md). What protects the platform
 * is the POLICY, and the policy is enforceable in the database today: no
 * balance, no API call. When real addresses arrive this ledger becomes an
 * accounting view of sats that actually sit somewhere, and `creditTicker` gains
 * a caller. Nothing here should be shown to a user as a wallet balance.
 */

/**
 * ⚠ SATS, PRICED AT $11.62/BSV — the rate verified live 2026-06-19 and recorded
 * in DECISIONS.md ("Fee model: 100 sat/kB everywhere"), NOT the ~$0.0017/post
 * figure that CLAUDE.md carried, which was wrong by two orders of magnitude.
 * At this rate 1 sat ≈ $0.0000001162.
 *
 * The ratio these constants expose is the important thing and it is worth
 * stating: **a reply costs ~26,000 sats of compute against ~113 sats of chain.**
 * Inference is ~230× the on-chain cost, so the blockchain is rounding error in
 * this system's economics and the model bill is the whole business.
 */

/** One definition re-derivation: ~4,600 in / 300 out on a small fast model ≈ $0.006. */
export const DERIVE_COST_SATS = 52_000;

/** One agent reply: ~1,700 in / 225 out ≈ $0.003. Not yet charged — see below. */
export const REPLY_COST_SATS = 26_000;

/**
 * What a word is given when first seen: exactly ONE derivation.
 *
 * Deliberately one and not several. Every word gets a definition once, so a
 * newly-claimed word is never dead on arrival — and the platform's total
 * exposure is then `words × DERIVE_COST_SATS`, which is a number that can be
 * stated: 10,000 words is ~$60, once, ever. A more generous grant multiplies
 * that by nothing useful, since a word that is actually being used will be
 * earning by its second derivation.
 */
export const FOUNDING_GRANT_SATS = DERIVE_COST_SATS;

export interface TickerBudget {
  symbol: string;
  grantedSats: number;
  earnedSats: number;
  spentSats: number;
  /** granted + earned − spent. Never negative. */
  balanceSats: number;
}

function normalise(symbol: string): string | null {
  const canonical = canonicalTicker(
    String(symbol ?? "")
      .trim()
      .replace(/^\$+/, "")
  );
  return isValidTicker(canonical) ? canonical : null;
}

/**
 * Create the row if absent, granting the founding allowance exactly once.
 *
 * `INSERT OR IGNORE` is what makes "exactly once" true even under concurrent
 * ticks: the second caller's insert is discarded rather than topping the grant
 * up again, so a word cannot be re-granted by being seen repeatedly.
 */
function ensureRow(symbol: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO ticker_budgets (symbol, granted_sats, earned_sats, spent_sats)
     VALUES (?, ?, 0, 0)`
  ).run(symbol, FOUNDING_GRANT_SATS);
}

export function getTickerBudget(symbol: string): TickerBudget | null {
  const canonical = normalise(symbol);
  if (!canonical) return null;
  const row = db
    .prepare(
      "SELECT symbol, granted_sats, earned_sats, spent_sats FROM ticker_budgets WHERE symbol = ?"
    )
    .get(canonical) as
    | { symbol: string; granted_sats: number; earned_sats: number; spent_sats: number }
    | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol,
    grantedSats: row.granted_sats,
    earnedSats: row.earned_sats,
    spentSats: row.spent_sats,
    balanceSats: Math.max(0, row.granted_sats + row.earned_sats - row.spent_sats),
  };
}

/**
 * Pay sats into a word — an invocation fee, a tip, anything earned.
 *
 * Not yet called by anything: invocation-as-payment is designed and unbuilt. It
 * is here so the debit side has a counterpart from the start rather than being
 * retrofitted onto a ledger that only ever went down.
 */
export function creditTicker(symbol: string, sats: number): void {
  const canonical = normalise(symbol);
  if (!canonical || !Number.isFinite(sats) || sats <= 0) return;
  ensureRow(canonical);
  db.prepare(
    "UPDATE ticker_budgets SET earned_sats = earned_sats + ?, updated_at = datetime('now') WHERE symbol = ?"
  ).run(Math.floor(sats), canonical);
}

/**
 * Take `sats` from a word's balance if it has them. Returns whether it did.
 *
 * ⚠ CONSUME BEFORE SPENDING, AND DO NOT REFUND ON FAILURE. This is the same
 * ordering `boot-orchestrator` uses for free-boot grants (DECISIONS.md, *"consume
 * the grant BEFORE paying"*), for the same reason: a crash between the debit and
 * the spend must lose the budget, never double-spend it. A model call that fails
 * after being issued may still have been billed, so a refund path would let a
 * flapping upstream drain the real money while the ledger showed none spent.
 *
 * Atomic by construction — the guard is in the UPDATE's WHERE clause, so two
 * concurrent ticks cannot both pass a read-then-write check.
 */
export function tryDebitTicker(symbol: string, sats: number): boolean {
  const canonical = normalise(symbol);
  if (!canonical) return false;
  const cost = Math.max(0, Math.floor(sats));
  if (cost === 0) return true;
  ensureRow(canonical);
  const res = db
    .prepare(
      `UPDATE ticker_budgets
          SET spent_sats = spent_sats + ?, updated_at = datetime('now')
        WHERE symbol = ?
          AND granted_sats + earned_sats - spent_sats >= ?`
    )
    .run(cost, canonical, cost);
  return res.changes === 1;
}

/** Whether a word could afford `sats` right now. Does NOT consume — see `tryDebitTicker`. */
export function canAfford(symbol: string, sats: number): boolean {
  const canonical = normalise(symbol);
  if (!canonical) return false;
  ensureRow(canonical);
  const budget = getTickerBudget(canonical);
  return (budget?.balanceSats ?? 0) >= Math.max(0, Math.floor(sats));
}
