# Security Audit — 2026-03-28

> Combined findings from code auditor (Jerry) and security ops (Paul). 53 total findings.
> Fix criticals before any real users. Fix highs this sprint. Fix mediums before public launch.

## CRITICAL (9 findings — must fix before real users)

### C1: CSP allows unsafe-inline + unsafe-eval — PARTIALLY FIXED
**File:** next.config.ts line 37
**Risk:** XSS = instant key theft. Any injected script reads localStorage WIF.
**Fix:** Removed unsafe-eval. unsafe-inline remains (needed for Next.js). Nonce-based CSP is the full fix (future).

### C2: WIF cached in JS module-scope variables
**File:** src/services/bsv/identity.ts lines 39-45
**Risk:** `_cachedWif` and `_sessionIdentity.wif` in memory for entire session. Any script can read.
**Fix:** Cache CryptoKey object instead of WIF string where possible. Accepted risk for plaintext path.
**Partial mitigation (2026-04-30, Stage 7):** the manage-gate session (`manageAuthed` in IdentityBar) is now destroyed on tab blur (`visibilitychange === "hidden"`). This bounds the *manage-flow* exposure window to active tab focus — but the underlying `_cachedWif` / `_sessionIdentity` caches in `identity.ts` still persist for the session. Full mitigation requires extending the tab-blur destroy to the identity-module caches and adding a configurable idle timer.

### C3: /api/boot-confirm accepts any txid without verification — FIXED
**File:** src/app/api/boot-confirm/route.ts
**Risk:** Attacker can fake boot confirmations, inflate contribution weight, game fairness system at zero cost.
**Fix:** (2026-04-03) Full fix: replay protection (txid dedup check + application-level SELECT before insert), rate limiting (10/min/IP), and on-chain output verification (parses WoC tx vout, compares addresses/amounts against recalculated split with 2 sat tolerance). DB-level uniqueness is composite `UNIQUE(txid, recipient_address)` at db.ts:117 — replay protection relies on the app-level check, not the index alone. **Upgrade (2026-04-14):** output verification no longer fetches from WoC. Client sends `rawTx`; server validates `hash(rawTx)===txid` (self-authenticating — can't be spoofed), parses P2PKH outputs locally from the raw bytes, and re-broadcasts via ARC as safety net. Eliminates 5–30s WoC indexing lag and removes a rate-limit chokepoint. Explicit `TX_CONFLICT` vs `ARC_UNAVAILABLE` error codes distinguish fatal from retriable. Trust boundary: the server accepts client bytes but the hash binding makes forgery computationally infeasible, so security posture is unchanged. **Booter authentication added (2026-06-14, Phase 1 Step 7):** the booter now signs `boot:<postId>:<txid>` (`src/lib/boot-message.ts`) with their identity key; boot-confirm verifies the ECDSA signature (createPost pattern) and DERIVES the credited address (`bootboard.boosted_by` + `boot_grants`) from the verified pubkey, never a client-supplied address. Closes boot-attribution FORGERY/FRAMING (crediting a boot to an arbitrary/victim address). Fails closed (401) before any DB write or re-broadcast.

### C3-residual: boot-attribution mempool-race self-credit — TRACKED (low, deferred)
**File:** src/app/api/boot-confirm/route.ts
**Risk (residual after Step 7):** An attacker who observes a victim's already-broadcast boot `rawTx` in the mempool can sign `boot:<postId>:<txid>` with the attacker's OWN key and POST boot-confirm BEFORE the victim's synchronous confirm — crediting the boot (attribution + `total_boots`) to the attacker. The victim's later confirm 409s as "already recorded" and `useBoot` treats 409 as idempotent success, so the victim is silently un-credited. **Fund-safe** (payout outputs are fixed in the victim's tx and pay the canonical server-recomputed split regardless of who claims the boot — only the `boosted_by` attribution moves), racy (must beat the victim's sub-second post-broadcast POST), and IP-rate-limited (10/min). Step 7's signature proves "I hold a key," not "I funded this tx," so self-credit survives though framing does not.
**Status:** DEFERRED (code-auditor verdict 2026-06-14: ship-as-is-with-tracking). Proper fix = prove the booter owns a tx input (input-script/funding-key binding) — genuinely heavier (couples confirm to input parsing, can't assume the booter funded from their identity address after UTXO consolidation), no clean cheap mitigation. Acceptable at launch scale: low severity, fund-safe, bounded.

### C4: Auto-download backup only has NEW key when fund transfer fails — SUPERSEDED (2026-06-14)
**Original file:** src/components/MoveAddressModal.tsx (rotation flow), src/services/bsv/backup-template.ts
**Original risk:** User told "old key is in backup file" but backup contains new key. Stranded funds unrecoverable.
**Prior fix:** (2026-04-30, Stage 7) Combined recovery file with both `wif_encrypted` + `oldWif_encrypted`.
**Superseded 2026-06-14:** Key rotation, sweep, and `MoveAddressModal` have been removed. The key/address never changes — there is no "new key" scenario. `backup-template.ts` no longer produces `oldWif_encrypted`; `pathType` is `"save"` or `"restore-pre"` only. The original attack surface (stranded funds on a new address) cannot occur. Recovery files are single-key only.

### C5: Free boot consumes grant even when broadcast fails — REVERSED (Phase 1 Step 8, 2026-06-14)
**File:** src/services/fairness/boot-orchestrator.ts
**Original (2026-03-28) bias:** grant consumed only AFTER successful broadcast — protected the USER's free boot when a broadcast failed.
**Reversed by Step 8** (DECISIONS.md "Free-boot path consumes the grant BEFORE paying", settled 2026-06-13): the server-funded free path spends the SERVER wallet's money, so the bias is deliberately inverted — `free_boots_used` is now consumed in an atomic check-and-increment transaction BEFORE the broadcast. A crash between a successful broadcast and the DB record can no longer let a retry make the server pay twice (the monotonic counter is the idempotency key — server-built free boots have no client txid). No refund on broadcast failure (ambiguous-failure safety: the tx may already be in the mempool). **Worst case is now "user loses one free boot, server pays once"** instead of "server pays repeatedly." **Hard Rule #3 acknowledged** — owner-sanctioned reversal of a control previously marked FIXED. The original USER-protection logic is unchanged on the paid/client-funded path (which consumes no server grant). **Follow-up (deferred):** refund on a *provably-pre-broadcast* failure status would restore the user's boot on e.g. server-wallet-empty — but needs a trustworthy "definitely did not submit" signal from the wallet/broadcast layer; doing it on the coarse `broadcast_failed` status would be unsafe (re-opens double-pay). Tracked.

### C6: Interrupted upgrade locks user out — FIXED then SUPERSEDED (2026-06-14)
**File:** src/services/bsv/identity.ts
**Original risk:** Power failure between setItem(encrypted) and removeItem(plaintext) = both keys exist; user locked out.
**Prior fix:** (2026-04-12) Deferred localStorage commit pattern via `upgradeIdentity()` + `commitUpgrade()`.
**Superseded 2026-06-14:** `upgradeIdentity`, `commitUpgrade`, and key rotation removed. `encryptInPlace` is a single atomic localStorage write — no multi-step intermediate state possible.

### C7: Double-upgrade from same key orphans intermediate posts — SUPERSEDED (2026-06-14)
**Original file:** src/app/actions.ts + src/services/fairness/weights.ts
**Original risk:** INSERT OR REPLACE deletes A→B migration when A→C is inserted. Posts made with key B have no migration chain, are permanently orphaned.
**Prior fix:** (2026-03-28) Bridging migration inserted to preserve both branches.
**Superseded 2026-06-14:** Key rotation and the `migrations` table have been removed. Keys never change; there are no migration chains to orphan. The attack surface no longer exists.

### C8: cleanupMigrations has no authentication — SUPERSEDED (2026-06-14)
**Original file:** src/app/actions.ts
**Original risk:** Anyone who knows a pubkey can delete that user's migration records. Targeted payout redirection.
**Prior fix:** (2026-03-28) Signed challenge with 5-minute timestamp replay protection. **`cleanupMigrations` subsequently deleted** — first without auth (E31, 2026-06-01) and then with the full rotation removal (2026-06-14). The `migrations` table and all migration server actions no longer exist. Attack surface is gone.

### C9: Backup warning dot clears on dropdown OPEN, not on actual backup — FIXED
**File:** src/app/IdentityBar.tsx lines 110-115
**Risk:** User thinks they're backed up after opening dropdown, but never actually copied or downloaded.
**Fix:** `markBackedUp()` now only fires from `handleDownload()`, `handleSaveEncrypted()`, and `handleCopy()` handlers — no longer on dropdown open. Verified 2026-04-10. **Hardened 2026-04-16 (commit `e7ecf9f`):** backup download now requires explicit "Got it" acknowledgement before `backedUp` flips. Prevents silent download failures (popup blocker, disk full, CSP deny, user cancels save dialog) from clearing the warning dot. Applied to the You dropdown (green confirmation banner replaces the orange save-CTA on success) and `MoveAddressModal` stage 1 (new `saved-confirm` gate before the irreversible sweep broadcast).

## HIGH (7 findings — fix this sprint)

### H1: Rate limiting keyed on client-supplied author name — FIXED
**File:** src/app/actions.ts line 24
**Fix:** (2026-03-28) Now keyed on verified pubkey.

### H2: /api/boot-shares exposes all contributor addresses unauthenticated — PARTIAL
**File:** src/app/api/boot-shares/route.ts
**Fix:** Rate limiting added (30/min/IP) at boot-shares/route.ts:12. Signed request for detailed shares still TODO. Updated 2026-04-10.

### H3: Console logs leak addresses and amounts client-side
**File:** Multiple (identity.ts, IdentityBar.tsx)
**Fix:** Remove financial detail from console.log in production.

### H4: Server wallet private key in process memory
**File:** src/services/bsv/wallet.ts
**Fix:** Document risk. Move to signing oracle when value increases.

### H5: Unsigned posts accepted with no attribution — FIXED
**File:** src/app/actions.ts lines 36-37
**Fix:** `createPost` rejects posts with missing pubkey/signature (`missing_pubkey` / `missing_sig` error codes). All posts must be ECDSA-signed and attributable.

### H6: /api/tx-hex is an open proxy with no rate limiting — FIXED
**File:** src/app/api/tx-hex/route.ts
**Fix:** (2026-03-31) Added 500/min/IP rate limit. **Extended 2026-04-14:** `/api/balance` (10s cache, 120/min/IP) and `/api/unspent` (3s cache, 180/min/IP) joined the proxy fleet with equivalent rate limiting, address format validation, retries on 429/5xx, and stale-cache fallback. All direct browser→WoC reads have been eliminated.

### H7: Migration registration after local key storage — FIXED then SUPERSEDED (2026-06-14)
**File:** src/services/bsv/identity.ts + src/app/IdentityBar.tsx
**Prior fix:** `upgradeIdentity()` returned encStore without storing; `migrateIdentity()` called first, then `commitUpgrade()` only on success. Atomic ordering.
**Superseded 2026-06-14:** `upgradeIdentity`, `migrateIdentity`, `commitUpgrade`, and key rotation removed. Protection is now `encryptInPlace` — a single atomic write with no multi-step ordering risk.

### Additional findings from tester audit (2026-03-28):

**BUG-1 (High) — FIXED:** `unlockIdentity` was dead code. No passphrase prompt existed. Added unlock UI panel to IdentityBar. needsUnlock state flows through useIdentity → context.

**BUG-2 (High) — FIXED:** Same as H7 above. Migration now registered before key storage.

**BUG-10 (Critical) — FIXED then SUPERSEDED (2026-06-14):** `migrateIdentity()` return value was never checked. Fixed 2026-03-28: upgrade aborts on failure; two manual chain repairs reconnected 280 orphaned posts. **Superseded 2026-06-14:** `migrateIdentity` and key rotation removed entirely; no migration step exists to fail.

**BUG-6 (Medium) — RESOLVED (Phase 1 Step 3, 2026-06-14):** The documented mismatch never actually materialized in shipped code — the client (`useBoot.ts`) always sent `identity.address` in the (misleadingly-named) `booterPubkey` field, so `bootboard.boosted_by` and `boot_grants` were already address-keyed on BOTH the free (`boot-orchestrator`) and paid (`boot-confirm`) paths, and the earnings outgoing-boots query (`boosted_by IN (...addresses)`) already worked for paid boots. The only real defect was the lying field name, which would have trapped the Step 7 boot-confirm auth work (a future `PublicKey.fromString(booterPubkey)` would throw on the address). Step 3 renamed `booterPubkey` → `booterAddress` across `boot-confirm/route.ts`, `useBoot.ts`, and `boot-orchestrator.ts` (a wire-field rename — client + server shipped together) so the contract is honest. **Deferred to Step 5:** the `boot_grants.pubkey` *column* (and the `pricing.getBootPriceForUser` param) still carry the `pubkey` name while holding addresses — a schema-level cosmetic rename bundled with the keying simplification when the migration-chain resolvers are deleted.

**BUG-9 (Critical) — FIXED:** `isIdentityEncrypted()` always returned false. Checked raw JSON string for "enc:" prefix but stored value is JSON wrapper. Every encrypted identity guard was broken — unlock prompt never appeared, stale key generated after upgrade. Fixed by JSON-parsing and checking .encrypted field.

## MEDIUM (8 findings — before public launch)

- M1: PBKDF2 at 100k iterations (increase to 600k)
- M2: Backup file contains plaintext WIF — PARTIAL. Protected users: WIF is AES-256-GCM encrypted in the recovery file (passphrase required to decrypt). Unprotected users: the "Show recovery key" / "Save recovery file" paths still expose plaintext WIF. **Note (2026-06-14):** the combined-file rotation path that encrypted the prior key under the new passphrase has been removed (rotation no longer exists). The plaintext exposure surface is unchanged from before Stage 7.
- M3: Migration signature has no timestamp validation — SUPERSEDED (2026-06-14). `migrateIdentity` and the `migrations` table removed with key rotation.
- M4: Rate limiter is in-memory, resets on restart
- M5: /api/earnings exposes full financial history unauthenticated — **PARTIAL.** Silently rate-limited 20/min/IP (`earnings/route.ts:87`). Still unauthenticated — the financial data exposure is unchanged, but enumeration is now bounded by IP. Promote to authenticated read once user accounts exist.
- M6: WIF reveal has no auto-hide timeout. **Partial mitigation (2026-05-01, Stage 8 C6):** the Show-recovery-key panel now requires an explicit `[Reveal key]` click to expose the WIF (no longer revealed by default), and shows a red warning above the masked key (*"Anyone with this key owns your account and any funds in it. Never share it."*). Replaces the previous always-visible-until-Hide pattern. Auto-hide timer still TODO.
- M7: /api/boot-shares triggers full weight calc with no cache — FIXED (30s TTL cache added)
- M8: Posts during upgrade window may be unsigned — SUPERSEDED (2026-06-14): encrypt-in-place is a single atomic write, so there is no "upgrade window"; `createPost`'s mandatory signature check means posts are always signed.

## LOW (6 findings — track as debt)

- L1: WIF paste field has no input masking
- L2: Backup filename contains user's anon name
- L3: Console error may leak partial server WIF
- L4: Rate limiter cleanup uses first caller's window
- L5: Direct WoC calls leak user addresses with IP
- L6: Clipboard not cleared after WIF copy

### BUG-11: Rotate-from-stale key takeover (E31 — FIXED 2026-06-01, SUPERSEDED 2026-06-14)
**Severity:** HIGH (pre-fix) — full account takeover by anyone holding any past WIF
**Original files:** `src/app/actions.ts` `migrateIdentity`, `src/components/MoveAddressModal.tsx`, `src/components/ChangePassphraseModal.tsx`, `src/app/IdentityBar.tsx`
**Risk (pre-fix):** A user holding a revoked key A could call `migrateIdentity` to rotate A→C, silently overwriting the legitimate `A→B` row and locking out the legitimate holder.
**Fix (2026-06-01):** Server rejected `migrateIdentity` for any pubkey with a forward migration; client preflight via `/api/restore-eligibility`; UI guard routing to `StaleKeyModal`.
**Superseded 2026-06-14:** Key rotation, `migrateIdentity`, `MoveAddressModal`, `StaleKeyModal`, `/api/restore-eligibility`, and the `migrations` table have all been removed. The attack surface (a `from_pubkey` with an existing forward migration) cannot be constructed when keys never rotate.

### L7: Stale-key attribution griefing — SUPERSEDED (2026-06-14)
**Original severity:** LOW — bounded per-victim, required key rotation as prerequisite.
**Superseded 2026-06-14:** Key rotation has been removed. There are no "old keys" or "new keys" — a user's address is permanent. The chain resolver (`resolveChain()` in `weights.ts`) and the `migrations` table have been deleted. Posts attribute directly to the signing pubkey forever. The prerequisite for this attack (a user having rotated their key, leaving the old WIF valid but revoked) cannot occur.

### L8: Free-post weight-farming — RISK-ACCEPTED / DEFERRED (2026-07-20)
**File:** src/services/fairness/weights.ts (per-post weight summed additively), src/app/actions.ts (200/IP/day post cap)
**Risk:** Pool payout weight is LINEAR in a pubkey's post count (`weights.ts` sums `sqrt(1 + boots×1.5) × decay` per post — the `sqrt` dampens BOOSTS-per-post, NOT post COUNT), and posting is free/server-funded. So an attacker can spam free posts to inflate their pool-weight share and skim a slice of genuine boosters' pool fees at ~zero personal cost. Bounded only by the 200-posts/IP/day cap (`ONCHAIN_POST_IP_LIMIT`) + 30-day decay (each IP plateaus ≈8,700 weight; pubkeys are free, so more identities don't help — IPs are the bottleneck). NOTE: `minPostsForPricing` (`pricing.ts`) guards the boot PRICE, not payout WEIGHT — different code paths; do not assume it covers this.
**Impact:** LOW — fairness dilution / reputation, not theft. Absolute value negligible at launch (pool = 80% of boot fees ≈ cents/day), ~$700–1k/yr worst-case at growth scale. Early on, *relative* share can be high (spam weight vs sparse genuine weight) even while absolute $ is trivial.
**Status:** RISK-ACCEPTED / DEFERRED per DECISIONS.md "Launch generous, tighten with scale". The cheap per-identity weight cap is sharding-bypassable (fresh keys are free → ineffective); the effective levers are structural (engagement-gated payout weight and/or posting costs) applied as the platform scales. Runtime formula change only — no on-chain format or DB-migration impact (`boot_split` carries `formula_version`), addable any time. On-chain payouts are irreversible, so the deferral carries a **tripwire:** revisit when daily paid-boost volume exceeds ~$50/day, OR any single identity/IP cluster holds >20% of total pool weight, OR the vector is publicly demonstrated.

## OBSERVATIONS — silent improvements + new findings (logged 2026-06-04 audit)

These were surfaced by the full-repo MD vs code audit on 2026-06-03. None are regressions. The silent improvements (OBS-S1–S4) are hardening that landed without a dedicated SECURITY_AUDIT entry at the time — logging here so the record matches reality. OBS-N1–N2 are new LOW findings from the audit (Hard Rule #3 surfacing).

### OBS-S1: `/api/posts` rate limit added — 120/min/IP
Read-only feed polling was historically unrate-limited by design (every client hits it every 5s). The Phase 6.2 audit (2026-04-09) added a 120/min/IP limit as defense-in-depth. CLAUDE.md previously stated the route was "unrate-limited by design" — the rate limit is generous enough that the original intent (no real client should hit it) holds, but the floor is now bounded.
**Status:** mitigation in place; doc reconciliation noted in 2026-06-04 audit follow-up.

### OBS-S2: `/api/restore-eligibility` (E29) — SUPERSEDED (2026-06-14)
**Original severity:** LOW — endpoint disclosing migration graph.
**Superseded 2026-06-14:** `src/app/api/restore-eligibility/route.ts` deleted. Key rotation and the `migrations` table no longer exist, so there is no migration graph to query. `RestoreModal` no longer calls this endpoint.

### OBS-S3: `dedupeUtxos()` in sweep flow — funds-safety hardening
`autoTransferFunds` and `sweepFunds` in `identity.ts` now route the raw `/api/unspent` response through `dedupeUtxos()` keyed on `(tx_hash, tx_pos)` before tx construction. Defeats the `bad-txns-inputs-duplicate` peer rejection that occurs when WhatsOnChain's indexer transiently returns the same outpoint twice (confirmed in Android device testing 2026-06-03 — two consecutive failures with identical txid `8fc71ef6…`, third attempt succeeded). Not a vulnerability fix — a structural safety net analogous to `client-boot.ts`'s existing `utxoKey` dedup. See DECISIONS.md "UTXO outpoint dedup on sweep paths".
**Status:** shipped 2026-06-03 commit `7891355`.

### OBS-S4: E30 stale-key detection in `/api/posts` — SUPERSEDED (2026-06-14)
Already documented in L7; noted here for cross-reference. Polling sent `x-opencook-pubkey`; server returned `key_status: { stale: true }` gated by `E30_STALE_KEY_ENABLED`. **Superseded 2026-06-14:** key rotation removed; stale keys cannot exist when the address never changes. The header, the `key_status` response field, and the `E30_STALE_KEY_ENABLED` env flag have all been removed. `StaleKeyModal` deleted.

### OBS-S5: `/api/transcribe` (Phase 8 mic rebuild) joined the cost-guarded proxy fleet — logged 2026-06-26
The voice-to-text mic was rebuilt (2026-06-25) as record + Groq Whisper: the browser POSTs audio to `/api/transcribe`, which forwards to Groq's Whisper endpoint. Like the paid `/api/agent` route, it is guarded against cost-abuse — **per-IP rate limit** (30/min, same `x-forwarded-for`→`x-real-ip` extraction as the other proxies), **concurrency cap** (`MAX_CONCURRENT = 4`), a **global daily circuit-breaker** (`TRANSCRIBE_DAILY_LIMIT`, default 2000, checked just before the paid upstream call), a 25 MB upload cap, and a 503 when `GROQ_API_KEY` is unset. No new attack surface beyond the existing proxy fleet; logged here for record-completeness (the guards live in `src/app/api/transcribe/route.ts` and are also described in CLAUDE.md). Not a regression.

### OBS-N1: `/api/agent` rate-limit header parsing inconsistency — FIXED 2026-06-05
**Severity:** LOW — minor rate-limit bypass vector.
**File:** `src/app/api/agent/route.ts:28`.
Other API routes extract the client IP from `x-forwarded-for` via `header.split(",")[0].trim()` (take the first hop, which is the client IP set by our trusted proxy). The agent route used the raw header value, which includes all proxy hops. An attacker can prepend a fake IP (`X-Forwarded-For: 1.2.3.4, real.ip.here`) so the rate-limit key becomes the full string — effectively a different bucket per fake-IP prefix.
**Impact:** allows extending rate-limit budget on `/api/agent` (Claude chat — Anthropic API costs). Bounded by Anthropic's own rate limits on our key; impact is cost rather than abuse.
**Fix shipped 2026-06-05:** switched to the canonical pattern used by 3 other external-API-proxying routes (`balance`, `tx-hex`, `unspent`) — `header.get("x-forwarded-for")?.split(",")[0]?.trim() ?? header.get("x-real-ip") ?? "unknown"`. The `x-real-ip` fallback covers Vercel deploys where `x-forwarded-for` may be absent. Auditor pre-check upgraded the proposed one-line fix to include the Vercel fallback (without it, every Vercel request would collapse to one shared "unknown" bucket — same DOS class the original fix was supposed to close).
**Follow-up (non-blocking):** the IP-extraction pattern is now repeated across 9 routes. Extracting a `parseClientIp(headers)` helper to `src/lib/rate-limit.ts` with a 4-case test would deduplicate and prevent future drift. Also `posts/route.ts:51` uses `.split(",")[0].trim()` without the optional chain — functionally equivalent, cosmetically inconsistent.
**Status:** FIXED.

### OBS-N2: `BootContext.claimBoot` non-atomic lock — FIXED 2026-06-05
**Severity:** LOW — bounded by multiple downstream locks.
**File:** `src/contexts/BootContext.tsx:50-57`, `src/hooks/useBoot.ts:48-55`.
The "global single-flight" boot lock was enforced via `setBootingPostId` (React state, asynchronous). Two near-simultaneous calls to `claimBoot` could both observe `bootingPostId === null` and proceed, both returning `true`. The caller in `useBoot.ts` made it worse by doing a separate `if (bootingPostId !== null) return` check before calling `claimBoot` — a textbook TOCTOU race against stale React state.
**Impact (pre-fix):** bounded by (a) pubkey-keyed server rate limit on `bootPost`, (b) deeper synchronous mutex in `client-boot.ts`, (c) on-chain double-spend rejection. Worst-case practical impact was one redundant server roundtrip per concurrent click → server returns TX_CONFLICT. No user-visible state corruption; no funds at risk.
**Fix shipped 2026-06-05:**
- Added `bootingPostIdRef` (`useRef<number | null>`) as the authoritative lock. Synchronous read/write — no batching window.
- `claimBoot` now does atomic check-and-claim against the ref and returns the actual claim result (was previously always returning `true`).
- `releaseBoot` and `failBoot` clear the ref alongside the existing state clear.
- The React state `bootingPostId` continues to mirror the ref for render purposes (disabled buttons, `isBooting` flag) — consumers (`Bootboard.tsx`, `PostList.tsx`) unchanged.
- Caller in `useBoot.ts` switched from `if (bootingPostId !== null) return; claimBoot(postId);` to `if (!claimBoot(postId)) return; setStatus("pending");` — single atomic gate. The stale "client-boot.ts mutex covers this" comment was removed (it was always wrong — that mutex runs after the server roundtrip).
- `bootingPostId` removed from `boot()`'s useCallback deps (no longer read inside) — small perf win since `boot()` no longer rebuilds on every lock flip.

Auditor verified diff: no fourth writer to ref or state; consumers correctly continue reading React state (intentional one-tick lag is harmless — any race-window click re-enters `claimBoot` which the ref blocks).
**Status:** FIXED.

## Phase 1 Deep-Audit (2026-06-15)

Exhaustive close-out audit over the whole Phase-1 surface (multi-agent workflow:
map → hunt → adversarial-verify-every-finding → completeness critic → synthesize).
42 raw findings → 17 confirmed after adversarial review. Money-conservation core
verified sound; rotation/migration removal left ZERO dangling code references.

**Must-fix — ALL FIXED:**
- **F1 (HIGH) — interrupted restore reverted to the OLD key.** getIdentity's
  both-present reconciliation preferred plaintext unconditionally (true for
  encrypt-in-place, false for restore = different key). Now address-compares the
  stores; different → drop stale plaintext, route to unlock. FIXED `1baba56`.
- **F2 (HIGH) — corrupted encrypted store trapped a funded user** (no restore
  escape in SignInModal). Added an always-available "Restore from a saved file"
  link. FIXED `1baba56`.
- **F3 (HIGH) — corrupt store silently auto-genned a new identity** (browser tab),
  orphaning funds. Added hasEncryptedStorePresent(); never auto-gen over a
  non-empty enc store; useIdentity routes it to unlock. FIXED `1baba56`.
- **F4 (Critical-integrity) — free boot with no server wallet burned a grant +
  recorded a phantom boot.** Early refusal before the consume. FIXED `206e2b1`.
- **F6 (Critical-money) — paid boot double-paid on weight/price drift** (confirm
  rejected an already-broadcast tx → retry rebuilt a new txid). Now records from
  on-chain outputs with a platform-cut floor; client never rebuilds after
  broadcast (incl. the thrown-fetch path the auditor caught). FIXED `9fdb99a`.
  See DECISIONS.md "Paid-boot confirm records from on-chain outputs".

**Nice-to-have — OPEN (tracked, not launch-blocking):**
- Cross-tab protect/change-passphrase wedges the OTHER tab in a stale "ready"
  state until reload (medium; recoverable, no fund loss; fix: flip Tab B to
  needsUnlock when id===null && isIdentityEncrypted() in the storage handler).
- Corruption messaging: decryptWif/changePassphrase say "wrong passphrase" on a
  corrupt-ciphertext store (F2's restore link mitigates the trap; a discriminated
  "corrupt" vs "wrong-pass" result is the fuller fix).
- shareOrDownloadBackup reports shared:true for the `<a download>` path with no
  success signal (3 callers flip the backed-up flag on an unverified download).
- Client OP_RETURN audit fields unvalidated (forgeable; DB attribution is
  signature-safe; advisory per the reader contract).
- Doc/comment drift: stale "across the full address chain" comments in
  earnings/route.ts; orphan migrations table fully removed from db.ts (no DROP for
  any pre-existing on-disk table — inert, moot for fresh-start launch).
- Free-boot path attribution still client-trusted (symmetric to Step 7; low —
  free boots are IP-capped + cost nothing); boot_grants.pubkey column naming.

**Device-test follow-ups (2026-06-15) — FIXED:** on-device QA surfaced two money-UX
(not money-loss — funds were always on-chain) defects:
- **Balance overstated spendable funds** — `/api/balance` summed confirmed + 0-conf
  UTXOs (showed ~7,687 vs 5,023 confirmed). Now split: `balance` = confirmed
  (spendable), `pending` = 0-conf; UI shows spendable headline + muted pending line.
  FIXED.
- **Deposit/affordability omitted the network fee** — a paid boot at "balance ≥
  price" still failed. `clientSideBoot` now surfaces the fee on `insufficient_funds`
  (the exact `estimateFee(1, outputCount)` threshold the branch tests); FundAddress
  measures shortfall against price + fee (provably always positive in the
  insufficient branch). Money-path re-audited PASS — pure value-surfacing, no
  selection/sign/broadcast change. FIXED. See DECISIONS.md "Balance shows spendable
  (confirmed), deposit shortfall includes the fee".

**Phase 2 Build A (2026-06-16) — server-wallet in-mutex timeouts — FIXED.** The
server wallet held its mutex across 4 un-timed external calls (unspent fetch,
source-tx-hex fetch, `tx.broadcast()`, double-spend lookup); any hang froze ALL
free boots + post-logging site-wide until the socket died (a self-DoS / liveness
hole). FIXED: 10s timeouts on the read calls (abort + fail-safe) + a 30s broadcast
timeout. The broadcast timeout is treated as INDETERMINATE and NEVER rebuilds —
a rebuild would mint a new txid and double-pay the server wallet — so it returns a
terminal `broadcast_timeout` that no retry path re-runs (the grant stays consumed,
not refunded; the UI shows no "tap to retry"). Auditor-verified money-safe (mutex
always releases, no rebuild reachable, no control weakened). See DECISIONS.md
"Broadcast timeout is INDETERMINATE — never rebuild". Builds B/C/D pending.

**Phase 2 Build B (2026-06-16) — dry-wallet grant-burn — FIXED.** A dry server
wallet used to consume the user's free-boot grant THEN fail at broadcast with no
refund (grant burned + error). FIXED: a pre-consume balance precheck in `executeBoot`
routes free boots to PAID before consuming the grant when the wallet can't cover
`price + fee` — fails toward paid (a WoC read failure reads low → paid, never
fail-open), fee-buffer-synced (`SERVER_FEE_BUFFER_SATS`) so it can't green-light-then-
burn. Plus a debounced low-balance console alert (`serverLowBalanceAlertSats` = 10k).
Auditor-verified: no grant-burn path, no fail-open, precheck strictly before the
consume. See DECISIONS.md "Dry server wallet routes free boots to paid". Builds C/D
pending.

**Phase 2 Build C (2026-06-16) — server-wallet kill-switch — ADDED.** `BSV_WALLET_SPEND_DISABLED`
(`isServerSpendDisabled()` in `wallet.ts`) halts ALL server-wallet spending in an
emergency: free boots route to PAID pre-consume (no grant burned), post-logging is
skipped via a `buildAndBroadcast` backstop. Paid/client boots are NOT gated (they
spend the user's funds; boot-confirm re-broadcast uses `parsed.broadcast()`, not the
gated path). Fail-closed (tripped = stops spending); env var (redeploy) with a
DB-backed runtime toggle as fast-follow. Unit-tested + auditor-verified PASS (no grant
burned, no paid-path over-reach). See DECISIONS.md "Server-wallet kill-switch". Build
D (broadcast proxy) optional/pending.

**On-chain money-integrity verification (2026-06-15) — PASS.** Independent
adversarial audit of all 29 mainnet `boot_split` txs for the test address against
the fairness config: every boot conserves value (Σinputs = Σoutputs + miner fee),
the paid boot's 5/15/80 split matches config to the satoshi (platform 249 = exact
5% of 4,992; net cost 3,703 after the user's own creator/pool share returned from
booting their own post), and all 29 OP_RETURN records are well-formed + consistent
(`v:1`/`app:opencook`/`type:boot_split`, `total` == on-chain split). DB payouts
ledger (7,172) matches the chain exactly — no value created/destroyed, no ledger
drift, no malformed/missing record. The only delta was a cosmetic earnings-display
LAG (UI showed 7,071 vs 7,172 on chain/DB) caused by a stale read before the last
free-boot payout row landed; the row exists (payout id 6347) and the figure
self-corrects on the next poll — NOT an open bug, same poll-staleness class as the
balance display fixed above.

## CSP `script-src` — `'unsafe-eval'` is DEVELOPMENT-ONLY (2026-08-14)

**Not a weakening of the production control.** The production `script-src` is unchanged
(`'self' 'unsafe-inline'`); `'unsafe-eval'` is appended only when
`process.env.NODE_ENV !== "production"`, i.e. under `next dev`.

**Why it was needed.** The CSP was applied unconditionally, so development got the production
`script-src`. React's dev build requires `eval()`, so **every dev page load threw** and pinned
the Next.js error overlay open. That is a security-relevant problem in itself: a permanent,
always-ignored overlay masks real errors during development, which is exactly when they are
cheapest to catch.

**Why `'unsafe-eval'` in production would matter.** It lets injected strings become executable
code, turning a content-injection bug into script execution — on a page that holds a BSV
private key in localStorage. That is why the split is enforced by a test rather than a
comment: `src/lib/next-config.test.ts` asserts `'unsafe-eval'` can never appear in a
production header, and that the rest of the production CSP (`default-src`, the deliberate
`img-src https:` relaxation for link previews, the ARC/WoC `connect-src` hosts,
`frame-ancestors 'none'`) is intact.

**DO NOT** make the flag unconditional, and do not gate it on anything other than `NODE_ENV`.
