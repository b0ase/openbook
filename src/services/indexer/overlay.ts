/**
 * Reading token state from our own BSV-21 overlay.
 *
 * ⚠ WHY AN INDEXER IS ON THE MONEY PATH AT ALL. A BSV-21 token's state is not
 * enforced by miners — *it is whatever an indexer says it is.* Once a word typed
 * on this board is a token on chain, "who holds $Occam" stops being a row we own
 * and becomes a question we ASK. That makes this file's failure modes economic,
 * not cosmetic, and it is why every answer here is a tagged union rather than a
 * number.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 *
 * **Never turn "I could not find out" into zero.** DEPLOY.md states the failure
 * this indexer is most likely to hand us: not an error, but *a room whose
 * holders all quietly vanish because the overlay was pointed at before it had
 * the data*. A zero balance and an unanswered question are the same shape and
 * opposite facts — one means "you own nothing", the other means "ask again".
 * Collapse them and a member is silently locked out of a room they paid for.
 *
 * So `balanceOf` returns a status, and there is deliberately no convenience
 * wrapper that unwraps it to a number. A caller must decide, in the open, what
 * to do when the answer is unknown.
 *
 * ── WHAT THIS OVERLAY DOES AND DOES NOT OFFER ────────────────────────────────
 *
 * Read routes (verified against `routes/bsv21.go` on the box, 2026-08-18):
 *
 *   GET  /api/1sat/bsv21/:tokenId
 *   GET  /api/1sat/bsv21/:tokenId/:lockType/:address/balance
 *   GET  /api/1sat/bsv21/:tokenId/:lockType/:address/history
 *   GET  /api/1sat/bsv21/:tokenId/:lockType/:address/unspent
 *   POST /api/1sat/bsv21/:tokenId/:lockType/{balance,history,unspent}
 *
 * ⚠ **THERE IS NO "WHO HOLDS THIS TOKEN" ROUTE.** Balances are keyed on
 * `p2pkh:<address>:<tokenId>`, so every question must NAME an address. We can
 * ask "does this person hold it"; we cannot ask "who holds it". A leaderboard is
 * therefore ours to assemble from addresses we already know — which we do — but
 * it can never include a holder who has never touched this platform.
 *
 * ⚠ **AND THE BATCH ROUTE IS A SUM, NOT A MAP.** `POST …/balance` takes an array
 * of addresses and returns ONE `balance` — `GetBalance(ctx, events, topic)` adds
 * every event together. It answers "how much do these people hold BETWEEN them",
 * which is a portfolio total and useless for attributing units to holders. Read
 * `combinedBalance`'s name as the warning it is; per-holder figures need one
 * request each.
 *
 * ⚠ **THE OVERLAY INDEXES ONLY WHITELISTED TOKENS.** Anything else answers
 * `503 {"message":"Topic not available"}` — which is the good case, because it
 * is distinguishable. The bad case is a token whitelisted seconds ago: topic
 * managers refresh on a 30-second ticker, so it answers 200 with a balance of
 * zero while it catches up. That window is real and this module cannot see into
 * it; only time closes it. Whitelist, wait, CONFIRM A KNOWN HOLDER READS
 * NON-ZERO, and only then trust a zero from this service.
 */

/** Where the overlay lives. nginx maps `/bsv21/` → `127.0.0.1:3055/` on the box. */
export const OVERLAY_BASE_URL = (
  process.env.BSV21_OVERLAY_URL ?? "https://api.b0ase.com/bsv21"
).replace(/\/+$/, "");

/**
 * The only lock type this overlay indexes by address.
 *
 * `lookups/bsv21-events-lookup.go` decodes the script suffix with `p2pkh.Decode`
 * and emits `p2pkh:<address>:<id>`. A token output locked by anything else — the
 * pay-to-mint covenant's own continuation, for instance — produces no address
 * event at all, which is correct: a contract is not somebody's address.
 */
export const LOCK_TYPE = "p2pkh";

/** How long any one overlay request may take before we give up on it. */
const TIMEOUT_MS = 8000;

/**
 * What the overlay was able to tell us.
 *
 * ⚠ `unknown` AND `notIndexed` ARE NOT THE SAME AND NEITHER IS ZERO.
 *  - `ok`         — the overlay answered. `units` is authoritative *if* the
 *                   token has finished syncing (see the 30-second note above).
 *  - `notIndexed` — this overlay has never been told to track the token. Its
 *                   holders exist on chain and are invisible here. Whitelist it.
 *  - `unknown`    — unreachable, timed out, or answered with something we cannot
 *                   read. Say so; do not guess.
 */
export type TokenBalance =
  | { status: "ok"; units: number; utxoCount: number }
  | { status: "notIndexed" }
  | { status: "unknown"; reason: string };

interface BalanceBody {
  balance?: unknown;
  utxoCount?: unknown;
}

/**
 * A JSON value as a non-negative whole number, or null if it is not one.
 *
 * ⚠ THIS EXISTS BECAUSE `Number()` TURNS ABSENCE INTO ZERO. `Number(null)`,
 * `Number("")` and `Number(false)` are all `0` — finite, non-negative, and
 * indistinguishable from a real empty balance. A first version of this file
 * used bare `Number(raw)` and its own test caught it: a response with no
 * `balance` field at all read as a confident zero, which is precisely the bug
 * this module was written to prevent. So the TYPE is checked first, and only a
 * number or a non-blank numeric string is allowed to become a figure.
 *
 * Strings are accepted because a uint64 balance does not survive JSON as a
 * number and services routinely send it quoted.
 */
function asCount(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);
  else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Turn one overlay response into a `TokenBalance`. Pure, so the mapping from
 * status codes to meanings is testable without a network.
 *
 * ⚠ A NON-NUMERIC `balance` IS `unknown`, NOT ZERO. JSON that fails to parse the
 * way we expect is the overlay telling us something changed; treating it as an
 * empty wallet would be this module inventing the very answer it exists to
 * avoid inventing.
 */
export function interpretBalance(httpStatus: number, body: unknown): TokenBalance {
  if (httpStatus === 503) return { status: "notIndexed" };
  if (httpStatus !== 200) return { status: "unknown", reason: `http ${httpStatus}` };

  const parsed = body as BalanceBody | null;
  const units = asCount(parsed?.balance);
  if (units === null) return { status: "unknown", reason: "balance was not a number" };
  return { status: "ok", units, utxoCount: asCount(parsed?.utxoCount) ?? 0 };
}

/**
 * A BSV-21 token id is its deploy outpoint. Checked before it reaches a URL —
 * the value is interpolated into a path, and an unvalidated one is a request to
 * somewhere we did not mean to ask.
 */
export function isTokenId(value: string): boolean {
  return /^[0-9a-f]{64}_[0-9]{1,10}$/.test(value);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${OVERLAY_BASE_URL}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // The overlay's answer changes as blocks land; a cached balance is a wrong
    // balance held with confidence.
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** How many units of `tokenId` this address holds, or why we cannot say. */
export async function balanceOf(tokenId: string, address: string): Promise<TokenBalance> {
  if (!isTokenId(tokenId)) return { status: "unknown", reason: "malformed token id" };
  if (!address) return { status: "unknown", reason: "no address" };
  try {
    const { status, body } = await getJson(
      `/api/1sat/bsv21/${tokenId}/${LOCK_TYPE}/${encodeURIComponent(address)}/balance`
    );
    return interpretBalance(status, body);
  } catch (e) {
    return { status: "unknown", reason: e instanceof Error ? e.message : "request failed" };
  }
}

/**
 * The SUM of what all these addresses hold between them — not a per-address map.
 *
 * ⚠ NAMED FOR WHAT IT RETURNS, because the route it calls is
 * `POST …/:lockType/balance` and reads as a batch. It is not one. Attributing
 * this figure to any single address overstates that holder by everyone else's
 * units. If you want per-holder numbers, call `balanceOf` once per holder.
 */
export async function combinedBalance(
  tokenId: string,
  addresses: readonly string[]
): Promise<TokenBalance> {
  if (!isTokenId(tokenId)) return { status: "unknown", reason: "malformed token id" };
  const list = [...new Set(addresses)].filter(Boolean);
  if (!list.length) return { status: "unknown", reason: "no addresses" };
  // The route refuses more than 100 and says so; refusing here keeps the error
  // ours rather than a 400 the caller has to decode.
  if (list.length > 100) return { status: "unknown", reason: "more than 100 addresses" };
  try {
    const res = await fetch(`${OVERLAY_BASE_URL}/api/1sat/bsv21/${tokenId}/${LOCK_TYPE}/balance`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(list),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return interpretBalance(res.status, body);
  } catch (e) {
    return { status: "unknown", reason: e instanceof Error ? e.message : "request failed" };
  }
}

/** Whether this overlay is tracking the token at all — the cheapest useful probe. */
export async function isIndexed(tokenId: string): Promise<boolean | null> {
  if (!isTokenId(tokenId)) return false;
  try {
    const { status } = await getJson(`/api/1sat/bsv21/${tokenId}`);
    if (status === 503) return false;
    // ⚠ 500 IS NOT "NO". The overlay returns `Failed to retrieve token details`
    // for a token it IS tracking but has no data for yet — observed on both
    // whitelisted test tokens, 2026-08-18. Answering `false` there would send a
    // caller off to re-whitelist something already whitelisted.
    if (status >= 500) return null;
    return status < 400;
  } catch {
    return null;
  }
}
