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
    // The only answer that means "this overlay was never told about the token".
    // It is returned before the lookup is even attempted, by the topic-manager
    // gate — so it is the one status that justifies whitelisting.
    if (status === 503) return false;

    /**
     * ⚠ 404 MEANS TRACKED-BUT-EMPTY, WHICH IS A "YES" TO THIS QUESTION.
     * Reaching the lookup at all means the topic manager exists; the token
     * simply has no data yet. Answering `false` would send a caller off to
     * re-whitelist something already whitelisted.
     *
     * ⚠ AND IT USED TO ARRIVE AS A 500, WHICH IS WHY THIS READS ODDLY. The
     * overlay's route compared `err.Error() == "token not found"` while its
     * storage returns `"outpoint not found"`, so the exact match never fired
     * and every genuine not-found fell through to the 500 catch-all. Fixed on
     * the box (see `ops/install-overlay-admin.sh`), but a 5xx is still treated
     * as "cannot say" rather than "no" — an indexer that is unwell must never
     * be read as an answer about a token.
     */
    if (status === 404) return true;
    if (status >= 500) return null;
    return status < 400;
  } catch {
    return null;
  }
}

/**
 * Ask this overlay to start watching a token.
 *
 * ⚠ THIS IS THE PIECE THE MIGRATION WAS MISSING, AND IT COULD NOT BE FAKED. The
 * overlay indexes only tokens it has been told about — `engine.Submit` returns
 * `ErrUnknownTopic` for a topic with no manager, so a mint cannot bootstrap its
 * own indexing by submitting itself. And a BSV-21 token's id IS its deploy
 * outpoint, so it cannot be pre-registered before the transaction exists
 * either. The only way through was an authenticated route on the overlay, which
 * now exists (`ops/overlay-admin.go`).
 *
 * ⚠ CALL IT AT DEPLOY TIME, NOT AT READ TIME. A token nobody asked us to watch
 * reads as a token with no holders, and `token-source.ts` will correctly refuse
 * to turn that into a balance — so the room simply will not work. The moment a
 * covenant is deployed is the moment to register it.
 *
 * ⚠ AND THE ANSWER IS NOT IMMEDIATE. Topic managers refresh on a 30-second
 * ticker on the box, so a read straight after this returns an empty answer that
 * is NOT authoritative. `markWhitelisted` records that we ASKED; it does not
 * record that the data has arrived.
 *
 * Server-only: it carries a secret. Never import this into a client component.
 */
export type WhitelistResult =
  | { ok: true }
  | { ok: false; reason: "no_token_configured" | "unauthorized" | "rejected" | "unreachable" };

export async function whitelistToken(tokenId: string): Promise<WhitelistResult> {
  if (!isTokenId(tokenId)) return { ok: false, reason: "rejected" };

  const secret = process.env.OVERLAY_ADMIN_TOKEN?.trim();
  /**
   * ⚠ A DISTINCT REASON, NOT A GENERIC FAILURE. An unconfigured deployment and
   * a rejected request are the same shape and completely different problems —
   * one is a five-second fix by the operator, the other means the token on the
   * box changed. Collapsing them sends whoever debugs this to the wrong place.
   */
  if (!secret) return { ok: false, reason: "no_token_configured" };

  try {
    const res = await fetch(`${OVERLAY_BASE_URL}/api/v1/admin/whitelist`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ token: tokenId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    // The route is idempotent — SAdd on a member already present is a no-op — so
    // a retry after a lost response is harmless. That matters: the alternative
    // to retrying is a token that is on chain and permanently unindexed.
    if (res.ok) return { ok: true };
    return { ok: false, reason: res.status >= 500 ? "unreachable" : "rejected" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
