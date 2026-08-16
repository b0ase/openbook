/**
 * Canonical envelope for EVERY app on-chain OP_RETURN record (post, boot_split).
 * Single source of the `app` tag, the `v` envelope version, and the `ts` stamp,
 * so the envelope can't drift between record types and the `app` literal lives
 * in ONE place (directly de-risks the Phase-7 OpenCook rename — see DECISIONS.md
 * "OpenCook Rebrand": a partial sweep of the `app` literal is an execution
 * hazard). Both builders — `onchain.ts` (post) and `lib/boot-audit.ts`
 * (boot_split) — produce their payload through this function.
 *
 * READER CONTRACT — any future consumer of these on-chain records MUST follow
 * these rules, so that records written today stay readable forever:
 *  - IGNORE unknown fields. A reader for `v:1` that encounters a `v:1` record
 *    carrying an extra field it doesn't recognize MUST NOT reject it (this is
 *    what makes adding a field later backward-safe).
 *  - SELECT a record stream by `(app, type)`. `type` is THE discriminator key
 *    (never `action`/`kind`). `post_id` is a per-app SQLite rowid, not global —
 *    key on `(app, post_id)`.
 *  - ⚠ MATCH `app` AGAINST `ONCHAIN_APP_HISTORY`, NOT AGAINST `ONCHAIN_APP`.
 *    This board's records exist under MORE THAN ONE `app` literal, because the
 *    name changed while records were accumulating. A reader that keys on the
 *    current literal alone silently loses every record written before the last
 *    rename — which for a permanence-first product is the worst possible
 *    failure, since the data is fine and only the reader is blind. Use
 *    `isOurRecord(app)`.
 *  - A MISSING `v` means a legacy / pre-version record — treat as `v: 0`.
 *  - BUMP `v` ONLY when an existing field's MEANING changes, or a field is
 *    removed/renamed. ADD new optional fields freely WITHOUT bumping `v`.
 *  - `ts` is the WRITER's clock: the server clock for server-built records
 *    (post, free boot), but the USER's browser clock for client-built records
 *    (paid boot — `client-boot.ts` runs in the browser). It is ADVISORY. The
 *    authoritative time is the block/confirmation time, NOT this `ts` — do not
 *    let attribution logic trust a client-built record's `ts` as ground truth.
 *
 * `app` is "openbook" — the on-chain brand identity, in ONE place, which is what
 * makes a rename a one-line change rather than the partial sweep DECISIONS.md
 * warns about.
 *
 * ⚠ THIS RENAME IS NOT LIKE THE LAST ONE, AND THE DIFFERENCE IS THE WHOLE POINT.
 * "bsvibes" → "opencook" (Phase-7, 2026-06-21) was a clean break from post #1
 * with no old records to stay compatible with. "opencook" → "openbook"
 * (2026-08-16, owner's call) happened with **2,081 records already inscribed**
 * under the previous literal, permanently. Those records are not editable and
 * were never going to be: the chain is the product. So the boundary is real and
 * forever, and it is a DEPLOY BOUNDARY, not a post id — posts kept being written
 * up to the moment this shipped.
 *
 * `v` is deliberately NOT bumped. The contract above says bump only when a
 * field's MEANING changes or a field is removed or renamed; `app` still means
 * exactly what it meant, it just holds a different value. Bumping would orphan
 * every reader of the ~2,000 already-anchored genesis records for no gain.
 *
 * NOTE: the (now-removed) migration signed-message `app` literal is a DIFFERENT
 * concern — its bytes are signed and re-verified, so it must never be routed
 * through this audit-record helper.
 */
export const ONCHAIN_APP = "openbook";
export const ONCHAIN_RECORD_VERSION = 1;

/**
 * Every `app` literal this board has ever written, oldest first.
 *
 * ⚠ APPEND, NEVER EDIT OR REMOVE. Each entry is a permanent fact about what is
 * already on the chain — dropping one does not tidy history up, it just makes
 * that stretch of history unreadable to us while it stays readable to everyone
 * else. On the next rename, append the new literal and change `ONCHAIN_APP`
 * above; nothing else needs to move.
 */
export const ONCHAIN_APP_HISTORY = ["bsvibes", "opencook", "openbook"] as const;

/** Whether an on-chain record's `app` tag is one of ours, past or present. */
export function isOurRecord(app: unknown): boolean {
  return typeof app === "string" && (ONCHAIN_APP_HISTORY as readonly string[]).includes(app);
}

export function onchainRecord(type: string, body: Record<string, unknown>): string {
  return JSON.stringify({
    v: ONCHAIN_RECORD_VERSION,
    app: ONCHAIN_APP,
    type,
    ...body,
    ts: Date.now(),
  });
}
