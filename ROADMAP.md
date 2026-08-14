# Roadmap

> What's done, what's next, what's planned. AI agents: update this file when you complete or start a task.
>
> Last updated: 2026-08-12
>
> **Current milestone:** Launch-critical plan — **Phases 1–7 COMPLETE.** Phase 1 (wallet / on-chain money integrity — rotation removal → encrypt-in-place, boot hardening, deep-audit fixes) **mainnet-verified 2026-06-15**. Phase 2 (server resilience — in-mutex timeouts + indeterminate-broadcast guard, balance precheck → free→paid, env-var kill-switch; Build D broadcast-proxy DEFERRED fast-follow). Phase 3 (governance — illegal-floor content filter + lawyer-ready disclaimer drafts + `/terms` `/privacy` + permanence gate). **Phase 4 — abuse/cost (2026-06-19):** durable on-chain retry (every post on-chain, no orphans), 200/day per-IP post cap + ~$0.20/day server-spend ceiling + kill-switch→refuse, boot-price anti-inflation (≥3-post identities), rate-limiter security fix — tests → 112, money-path auditor-verified. **Deferred (no invariant weakened):** rate-limiter LRU cap, persist agent counter, prompt cache_control, user-funded posting escape valve. **OWNER before public launch (NOT build blockers):** set `CONTENT_DENYLIST`; ensure a trusted proxy sets `x-forwarded-for` (the per-IP caps depend on it); ~1hr lawyer on the 3 hard risks (GDPR-erasure, CSAM/broadcaster, money-transmitter); DMCA agent; fill doc `[TODO]`s. **Phase 5 — observability (2026-06-20):** one read-only `/api/health` endpoint (200 healthy / 503 when a critical condition trips) → a free uptime monitor (UptimeRobot) emails the operator; in-app webhook deferred (owner uses no chat app). **Phase 6 — e2e harness (2026-06-20):** 38 integration tests (194 total now: 156 unit + 38 integration) covering the money path, refuse-gates, durable sweep, and health — in-memory SQLite + real @bsv/sdk crypto + mocked chain, one additive `broadcastTx` seam. **Phase 7 — rebrand → OpenCook (2026-06-21):** name-only sweep — on-chain `app` flipped to `opencook` (one constant, no `v` bump), storage keys `bsvibes_*`→`opencook_*` (`bfn_*` identity keys KEPT), copy/metadata/PWA/domain (opencook.fun)/legal/logo (Open amber + Cook white; removed the iOS amber top band); 55 files, 150/150 tests + build green; `bfn_` intact. **Owner follow-ups (DONE):** GitHub repo renamed to `opencook` + "OC" icon artwork shipped (commit `595174f`); historical brand refs in DECISIONS/SESSION_LOG left as honest record. **Phase 8 — cross-device QA (IN PROGRESS, 2026-06-24→25):** owner device-testing on desktop + Android + iPhone, fixes applied across several rounds — balance/chip display (spendable vs 0-conf pending, pending moved beneath the chip), recovery-file preview UX, passphrase-copy correctness, feed-scroll, the iPhone keyboard-viewport issue (header/bootboard pushed off-screen when the keyboard opens — root-caused; both a `visualViewport`-JS fix and a CSS `position:fixed` fix tried + reverted, accepted as a known cosmetic quirk: no clean iOS-Safari fix exists for this layout, see DECISIONS #6), "Upload your saved file" wording, app-icon amber shine. Owner re-testing the keyboard fix on-device. See SESSION_LOG + the Phase 8 DECISIONS entries. **In-app browser handling rebuilt to its final form (2026-06-29→30):** client-side read-only live feed (Telegram-iOS detected via `window.TelegramWebviewProxy` + UA; X/Instagram/Facebook via UA) — any write opens an "open in your browser" prompt (`InAppPromptModal`); a detection-independent value-gate hides the deposit address until the account is backed up; the old server-side splash + `InAppStandaloneGuard` components were DELETED and `page.tsx` reverted to static/ISR. iPhone Telegram read-only verified on-device; Android Telegram opens in real persistent Chrome (correctly NOT read-only). See DECISIONS "In-app browsers ... read-only live feed". Then Phase 9 deploy (work `LAUNCH_CHECKLIST.md`). **Genesis/launch prep (2026-08-02):** first piece — the **launch pool cutoff** — shipped: a `launchTs` epoch (env `LAUNCH_TS`, UTC, fail-closed far-future sentinel default) excludes pre-launch + genesis-seed posts from the 80% pool AND the boot-price count so the pool starts fresh at launch (they still earn the 15% creator bonus on boosts); money-path auditor SHIP, tests → 199. **Genesis seeding COMPLETE (2026-08-09):** all 1,908 backdated genesis posts seeded on-chain (~40 batched self-chained OP_RETURN txs, canonical `opencook`/`post` v1 envelope + `genesis:true` + real `posted_at`, operator-attested/unsigned; two agent-verified run fixes — explicit ARC broadcaster + fee 100→110 sat/kB). Clean launch DB built (2,006 posts = 98 kept + 1,908 genesis, chronological ids, empty bootboard) and swapped in as the local dev DB; pristine master kept off-repo for deploy. **DEPLOYED LIVE — Phase 9 core DONE (2026-08-11):** dedicated server wallet generated + funded (~0.99 BSV swept off the old shared key) + verified (`/api/health` ok); genesis DB auto-seeds the Railway volume via an npm `prestart` hook (`scripts/seed-if-empty.mjs`, copy-if-empty — never overwrites live data); **site is LIVE on Railway serving all 2,006 posts**. Fixed en route: two `next build` DB-concurrency bugs (idempotent ADD COLUMN + `busy_timeout`), Docker `VOLUME`, and the Railway-startCommand-not-shell-wrapped gotcha (all in SESSION_LOG). **Remaining (all quick config):** point `opencook.fun` + go-public flips — `CONTENT_DENYLIST` (before inviting posters), `LAUNCH_TS` (UTC) + `ALLOW_INDEXING=true` (at go-public), UptimeRobot on `/api/health`, off-Railway DB backup. Work `LAUNCH_CHECKLIST.md` Stage 3→4. See memory `project_server_key_ops` + `project_opencook_genesis_seed`. NOTE: the "Phase N" headings below are the LEGACY build phases; the launch-critical "Phase 1/2/…" sequence lives in DECISIONS.md + memory.

## Phase 1: Foundation — COMPLETE

- [x] Project setup (Next.js + TypeScript + Tailwind)
- [x] SQLite database with posts table (WAL mode, auto-migration)
- [x] BSV identity system (auto-generated keypairs, anon names, WIF in localStorage)
- [x] Post creation with cryptographic signing (ECDSA via @bsv/sdk)
- [x] Minimal GPT-style dark UI (centered layout, post box + feed)
- [x] Key backup system (copy to clipboard + download JSON)
- [x] Documentation (Vision, Identity, Security discussions)

## Phase 1.5: UI Overhaul & Bootboard — COMPLETE

- [x] Renamed project to BSVibes (from "Build From Nothing") → rebranded to OpenCook 2026-06-13
- [x] Telegram-style feed layout (newest at bottom, scroll-to-bottom with unread count)
- [x] Bootboard feature (pay-to-spotlight, boot counter per post, live timer)
- [x] Bootboard animations (shake, glow, slide-in on holder change)
- [x] Compact bootboard with expandable history
- [x] Genesis section (founding conversation, collapsible, persisted visited state)
- [x] Identity chip in header (replaces full identity bar)
- [x] Enter-to-post with auto-refocus after posting
- [x] Voice-to-text microphone button (record + Groq Whisper — rebuilt 2026-06 from the unfixable Web Speech API)
- [x] Agent chat (Claude Haiku API, full project context, modal overlay)
- [x] Telegram-style post button (mic when empty, send arrow when typing)
- [x] Hidden scrollbars, word-break for long content
- [x] "Agentic Fairness" subtitle in header
- [x] "created with bopen.ai" attribution
- [x] Boot button UX: oval pill, vertically centered right of post, count below
- [x] Scrollable bootboard history with reboot buttons (up to 50 entries)

## Phase 1.6: Real-Time, UX & Deployment — COMPLETE

- [x] Real-time feed polling (GET /api/posts every 5s, pauses when tab hidden, resumes on visibility)
- [x] Optimistic UI on posting (post appears immediately with spinner + reduced opacity, auto-removed when server confirms)
- [x] Identity loss warning dot (amber pulsing dot on identity chip until user opens dropdown for first time)
- [x] Cursor-based pagination ("Load earlier posts" button, getOlderPosts server action)
- [x] PWA manifest + icons (Add to Home Screen on iOS/Android/Desktop)
- [x] Deployment prep (Railway config, Dockerfile, env var DB path, .env.example)
- [x] Incremental polling via ?since_id (only fetches new posts, not full 100 every 5s)
- [x] DB indexes on bootboard (post_id, held_until)
- [x] Bug fixes: PostList stale state, timeAgo logic error, AgentChat stale closure, dropdown click-outside
- [x] Code hygiene: shared system prompt, dead code removed, .dockerignore, break-words

## Phase 2: Security Hardening — COMPLETE

- [x] Server-side signature verification (ECDSA verify via @bsv/sdk, rejects invalid sigs)
- [x] Rate limiting (in-memory sliding window: 10 posts/min, 5 boots/min, 10 agent calls/min)
- [x] Hide WIF from DOM (masked by default, reveal toggle, copy/download still work)
- [x] JSON.parse try/catch in identity.ts (corrupted storage returns null instead of crash)
- [x] CSP headers (Content-Security-Policy, HSTS, Permissions-Policy added)
- [x] bootPost input validation + transaction wrapper (prevents race conditions)
- [x] Foreign key enforcement enabled in SQLite
- [x] Agent chat input capped (20 messages, 2000 chars each)
- [x] Error boundary added (error.tsx)
- [x] Identity dropdown language fixed (removed "key" from UI copy)
- [x] localStorage error handling (try/catch on setItem, graceful degradation in private browsing)
- [x] BSV SDK import failure handling (catch in useIdentity, sets error state instead of infinite loading)
- [x] Multi-tab identity race condition (re-check storage after async key generation)
- [x] DB init error handling (try/catch with descriptive error messages)
- [x] LiveTimer negative time guard (clock skew protection)
- [x] Post success feedback (green flash + "Posted" indicator)
- [x] Agent chat discoverable ("Ask AI" pill button replaces hidden text)
- [x] Identity loading state (dynamic placeholder + pulse animation)
- [x] Streaming agent responses (SSE via /api/agent route, progressive text display)
- [x] UI labels updated (identity dropdown copy rewritten, no longer says "key")
- [x] Manifesto / vision TLDR above Genesis section (V2 "The Signal" copy)
- [x] "Agentic Fairness" subtitle clickable (scrolls to manifesto)
- [x] "Chat with the agent" link in manifesto scrolls to bottom + highlights Ask AI button

## Phase 3: On-Chain Integration — COMPLETE

- [x] Server wallet service (BSV_SERVER_WIF env var, UTXO fetching via WhatsOnChain, ARC broadcast)
- [x] OP_RETURN posting (OP_FALSE OP_RETURN with JSON payload, fire-and-forget after DB insert)
- [x] Transaction ID storage (tx_id updated on post row after successful broadcast)
- [x] On-chain verification link (green chain icon on posts, links to WhatsOnChain)
- [x] Wallet generation script (scripts/generate-wallet.mjs)
- [x] Graceful degradation (no BSV_SERVER_WIF = DB-only, no errors)

## Phase 4: Security Upgrades — COMPLETE

- [x] AES-256-GCM passphrase encryption (Web Crypto API, PBKDF2 100k iterations)
- [x] "Protect" flow in identity dropdown (optional, user-initiated) — `encryptInPlace`, address unchanged
- [x] Change passphrase flow — `changePassphrase`, re-encrypts same key, address unchanged
- [x] ~~Key rotation on upgrade (new keypair, old key signs migration)~~ — **REMOVED 2026-06-14.** Replaced by encrypt-in-place. The key/address never changes; adding or changing a passphrase wraps the existing WIF.
- [x] ~~On-chain migration record (OP_RETURN linking old pubkey → new pubkey)~~ — **REMOVED 2026-06-14.** `migration.ts` deleted; `migrations` DB table dropped.
- [x] ~~Server-side migration verification + DB storage~~ — **REMOVED 2026-06-14.** `migrateIdentity`, `verifyMigrationChain`, `cleanupMigrations` server actions deleted.
- [x] Protected/Unprotected indicator in identity dropdown
- [x] Session-cached decrypted identity (plaintext never written back to localStorage)
- [x] Version-gated restore: recovery files require `fileVersion: 1`; legacy plaintext + pre-stamp encrypted files rejected as `unsupported_version` (intentional "start clean" policy, 2026-06-14)
- [ ] Passkey wrapping (WebAuthn PRF, biometric unlock) — future
- [ ] Firefox passphrase fallback — future
- [ ] Deferred activation prompt (nudge at earnings threshold) — future
- [ ] Session timeout for encrypted identities (auto-lock after inactivity) — future
- [ ] Device sync via QR code (faster identity import between devices) — future
- [ ] PBKDF2 increase to 600k iterations — future (when real funds flow)

## Phase 5: Self-Funded Posting — PARTIAL

- [x] UTXO check via WhatsOnChain API (built in client-boot.ts)
- [x] Client-side transaction building with change output (built in client-boot.ts)
- [x] Silent switch between server-funded and self-funded (free → paid auto-switch)
- [ ] Daily posting limits (5 free/day) — deferred. Current spam defense is 10/min rate limit only. See FAIRNESS.md Gaming Analysis.
- [ ] QR code funding when limit reached — depends on daily limits above

## Phase 6: Fairness & Revenue — COMPLETE

- [x] Fairness config (tunable parameters, governance surface)
- [x] Dynamic boot pricing (contributors × 156, floor 1000, ceiling 250000, cached 1h)
- [x] Contribution weight calculation (sqrt × decay × engagement; posts attribute directly to signing pubkey)
- [x] No-custody payout split (every sat out in same tx, no DB balances)
- [x] UTXO manager (reservation, 0-conf chaining, multi-input aggregation)
- [x] Multi-output split transaction builder (P2PKH outputs + OP_RETURN audit)
- [x] Boot orchestrator (full workflow: validate → price → score → split → broadcast → record)
- [x] Boot grants table (15 free boots per pubkey)
- [x] Payouts audit table (records every split for transparency)
- [x] FundAddress component (deposit address panel for users who exhaust free boots)
- [x] Wire bootPost action to orchestrator (free boots → server, paid → client trustless)
- [x] Client-side trustless boot tx builder (browser builds split tx directly to contributors)
- [x] Boot shares API endpoint (/api/boot-shares — contributor list for client tx building)
- [x] Boot confirmation API endpoint (/api/boot-confirm — audit trail after client broadcast)
- [x] Auto-switch: free → server pays, has BSV → client pays trustlessly, no balance → fund QR
- [x] UI: boot price display on buttons (tooltip) and bootboard (empty state)
- [x] UI: free boot counter ("FREE" badge + remaining count in tooltip)
- [x] UI: fund address modal (shows deposit address when user has no BSV balance)
- [x] Boot button handles full flow: free → server, paid → client trustless, no funds → QR modal
- [x] UI: earnings display on identity chip (sats earned) + dropdown (total earned section)
- [x] Earnings API endpoint (/api/earnings — sum payouts by address)
- [x] Boot status API endpoint (/api/boot-status — free boots remaining for client sync)
- [x] UTXO reliability: spent-blacklist, retry logic, largest-first selection, error logging
- [x] Fund modal with balance breakdown (shows actual balance vs boot cost)
- [x] LIVE AND WORKING: posts on-chain, boots splitting payments, earnings accumulating
- [x] Security audit: 9 critical + 3 high findings fixed (SECURITY_AUDIT.md)
- [x] CSP hardened, boot-confirm verifies on-chain, unsigned posts rejected
- [x] Identity import with automatic migration cleanup
- [x] Earnings sparkline chart, Noob/Goat currency toggle, live balance polling
- [x] Forced backup download on security upgrade, interrupted upgrade recovery
- [x] Passphrase unlock UI (users no longer locked out after refresh with encrypted identity)
- [x] Atomic migration ordering (server confirms before key stored locally)
- [x] ~~Identity import with automatic migration cleanup~~ — **REMOVED** (commit `d7730cc`). `cleanupMigrations` deleted; the entire rotation model was subsequently removed (2026-06-14, see Phase 4).
- [x] Full tester audit: all identity/upgrade paths verified
- [x] Migration return value checked — upgrade aborts if migration fails (prevents orphaned posts)
- [x] Full identity dropdown redesign: radical simplification (43→24 state vars, extracted UpgradeModal, shared PassphrasePrompt). *UpgradeModal subsequently deleted in Stage 8 batch 1 (2026-05-01) — orphaned after Stage 6 modal restructure consolidated everything into MoveAddressModal.*
- [x] Self-contained HTML recovery files with embedded decryption (replaces JSON backups)
- [x] Private & Offline banner in recovery files
- [x] Re-auth grace window (60s) for sensitive actions (Copy/Show/Save/Restore)
- [x] Passphrase hints on upgrade + recovery files
- [x] Identity card split: informational card + "Manage identity" modal with labeled action rows
- [x] Change passphrase flow (2-step: verify current, enter new, key rotation + recovery file)
- [x] Copyable receive address on card header (own row, copy icon, "Copied!" feedback)
- [x] "Not protected" bar clickable — opens upgrade modal directly with chevron affordance
- [x] Memory clue always visible (no toggle), shown immediately on import + re-auth
- [x] Single passphrase entry for save (re-auth → save, no double prompt)
- [x] Error logging for on-chain post failures and wallet broadcast failures
- [x] UTXO consolidation: smallest-first selection, up to 20 inputs per boot, gradual defrag
- [x] Explicit fee model: SatoshisPerKilobyte(100) — no GorillaPool round-trip, ARC-compatible
- [x] Auto-consolidation for heavily fragmented wallets (WoC broadcaster at 10 sat/kb)
- [x] Spent UTXO persistence (localStorage) — prevents double-spend after page refresh
- [x] Earnings-only notification: chip flashes for real payouts, not balance changes (30s poll)
- [x] Server wallet self-healing: DOUBLE_SPEND_ATTEMPTED → blacklist competing inputs → auto-retry
- [x] TimeAgo timestamps refresh every 60s without page reload

## Phase 6.1: Second Audit (2026-04-03) — COMPLETE

- [x] 5-agent parallel audit (architecture, security, performance, tidiness, correctness)
- [x] boot-confirm: replay protection, rate limiting, on-chain output recording — records payouts FROM the verified on-chain outputs with a platform conservation floor (Finding 6, 2026-06-15), NOT recompute-and-reject (which double-paid on legitimate price/weight drift)
- [x] boot-confirm booter authentication (Phase 1 Step 7, 2026-06-14) — booter signs `boot:<postId>:<txid>`; credited address derived from the verified pubkey, not client-supplied (closes boot-attribution forgery). Residual mempool-race self-credit tracked in SECURITY_AUDIT.md C3-residual.
- [x] NaN weight cascade fix (SQLite datetime parsing)
- [x] Server wallet retry limit (was unbounded recursion)
- [x] SQL parameterization in pricing query
- [x] Rate limiting on all API routes (boot-shares, boot-status, earnings, posts 120/min)
- [x] calculateWeights() 30s TTL cache
- [x] Tab visibility checks on balance/earnings polling
- [x] Dynamic @bsv/sdk import in server actions
- [x] Migration message structural validation
- [x] Dead code removal + tidiness cleanup (11 items)
- [x] IdentityBar.tsx decomposition (1,632→1,150 lines — PassphrasePrompt, UpgradeModal, ChangePassphraseModal extracted)
- [x] Extract shared useBoot hook (deduplicates boot flow, adds consolidation to Bootboard reboots)
- [x] Unit test suite (Vitest: 27 tests — split, pricing, weights, rate-limit)
- [x] Deduplicated shared utilities (downloadBackup, getStoredHint)
- [x] Post-fix re-audit: all fixes verified, dead code cleaned, false-positive tests rewritten

## Phase 6.2: Cost Model & Documentation Audit (2026-04-09/10) — COMPLETE

- [x] Free boots pay floor price only (1,000 sats) — bounds per-user subsidy at ~15,690 sats regardless of scale
- [x] Per-IP free-boot cap (40/IP/24h, in-memory) — backstops the per-identity grant against fresh-identity-per-incognito-tab server-wallet drain; fails toward paid (Phase 1 Step 6, 2026-06-14)
- [x] Free-boot idempotency (Phase 1 Step 8, 2026-06-14) — `executeBoot` consumes the grant atomically BEFORE broadcasting (counter = idempotency key), so a crash between broadcast and DB write can't double-pay the server wallet; no refund on broadcast failure (reverses C5 bias for the server-funded path, per DECISIONS.md)
- [x] On-chain boot record harmonized (Phase 1 Step 9, 2026-06-14) — both boot paths emit one JSON OP_RETURN shape via shared `boot-audit.ts` (closed the paid-boot `v:1` gap from Step 1); added `booter` + `funded` audit metadata so who-booted-which-post is durable on-chain from launch
- [x] Fee rate documentation corrected (100 sat/kb, not 500 — code was always 100, docs were wrong)
- [x] FAIRNESS.md corrected: Gaming Analysis (no 5-post daily cap — was aspirational), OP_RETURN spec (removed phantom fields), scaling table (actual fee math), minimum payout (1 sat not 100)
- [x] 4-agent forensic audit: cross-referenced CLAUDE.md, DECISIONS.md, FAIRNESS.md, SECURITY_AUDIT.md against code
- [x] CLAUDE.md updated: Architecture (React 19.2, Turbopack, React Compiler, Biome), Key Files (layout.tsx, utils.ts), Identity (all localStorage keys), UX rule softened, Security Notes corrected
- [x] SECURITY_AUDIT.md: C9 promoted to FIXED, H2 to PARTIAL, C3 index description corrected, M2 corrected to PARTIAL
- [x] Rate limit added to /api/posts (120/min/IP — was the only unprotected route)
- [x] ROADMAP.md, FAIRNESS.md, DECISIONS.md dates updated
- [x] Boot button 3-second throttle (BootContext) — prevents rapid-click cascade
- [x] ~~"Move to a new address" wizard (MoveAddressModal)~~ — **REMOVED 2026-06-14.** Key rotation, sweep, and on-chain migration replaced by encrypt-in-place (`ProtectModal` + `ChangePassphraseModal`). Address is permanent.
- [x] Broadcaster unified to ARC (2026-04-13): all tx paths (clientSideBoot, consolidateUtxos, sweepFunds, autoTransferFunds, server wallet) use ARC via @bsv/sdk default. Previous WoC broadcaster switch was based on a misdiagnosed ARC outage (local DNS issue).
- [x] Server-side source tx cache in /api/tx-hex (~2000-entry in-memory LRU). Eliminates WoC rate-limit failures on boots with many inputs.
- [x] Batched source tx fetches in clientSideBoot (BATCH_SIZE=5, 1s delay).
- [x] Sweep warning UI when fund transfer fails (non-blocking, shows in Stage 2 + Stage 4 summary)
- [x] Optimistic UTXO blacklist removed (2026-04-13) — caused permanent wallet lockout with no recovery. Double-spend prevention now via mutex + 0-conf chaining + 3s UI throttle.
- [x] Confirmed-only filter removed (2026-04-13) — redundant at 100 sat/kb (all txs confirm next block). Was built for 10 sat/kb era when unconfirmed meant "permanently stuck."
- [x] WoC rate-limit mitigation via cached server proxies (2026-04-14) — `/api/balance` (10s TTL) and `/api/unspent` (3s TTL) join `/api/tx-hex`. All direct browser→WoC reads removed. Fixes 429 cascades that broke paid boots and froze balance polling.
- [x] Boot confirmation via local tx parsing (2026-04-14) — client sends `rawTx`, server verifies `hash === txid` and parses P2PKH outputs locally. Eliminates 5–30s WoC indexing lag from the boot-confirm path. Server re-broadcasts via ARC as safety net. Explicit TX_CONFLICT vs ARC_UNAVAILABLE codes.
- [x] Structured error-code matching for broadcast failures (2026-04-14) — replaces substring search that produced false positives on numbers appearing inside txids.
- [x] Live activity + earnings-history refresh when dropdown open (2026-04-15) — IdentityBar 30s poll now uses `summary=1` fast path when closed and the full earnings payload (activity + sparkline) when open. Recent boots/payouts appear within 30s of the DB insert instead of waiting for a close→reopen cycle. Tab-visibility gated.

## Phase 6.5: UX Polish — IN PROGRESS

> Active launch-prep plan with full bucket breakdown and confirmed decisions: see **LAUNCH_PLAN.md**.

> **Phase 2 (launch-critical server resilience) — A + B + C DONE 2026-06-16 (auditor-verified); Build D + small items DEFERRED (fast-follow).** Shipped: **A** in-mutex timeouts on all 4 server-wallet calls + indeterminate-broadcast guard (closes the platform-freeze + the broadcast-timeout double-pay); **B** dry-wallet → route free→paid (pre-consume balance precheck, no grant burned) + debounced low-balance console alert; **C** env-var kill-switch `BSV_WALLET_SPEND_DISABLED` (fail-closed, pre-consume). These close the money-loss / freeze / drain risk tier. The build-spec below is now mostly satisfied — the REMAINING deferred work is:
> - **Build D — `/api/broadcast` proxy + provider failover (GorillaPool→TAAL) + shared broadcaster module + server-side `/api/tx-hex`+`/api/unspent` cache reuse.** **WHY DEFERRED:** D is third-party-*availability* hardening, a different and lower risk tier than A–C — but note its real teeth: a single ARC provider is a SPOF, so an outage today = no boots at all (server-free AND client-paid). It's also the biggest piece (touches the client paid-boot path too). **WHEN TO REVISIT:** launch-hardening fast-follow, or SOONER if a broadcast-provider outage is observed (precedent: GorillaPool outages 2026-04-08 / 04-14). **MONEY-SAFETY GUARDRAILS when built (from the Phase-2 red-team):** the proxy must SUBMIT-SAME-BYTES-OR-REPORT ONLY — never re-fee / re-serialize / rebuild a tx (any of which changes the txid → double-pay) — and must preserve ARC's structured error codes (257/258/indeterminate) that the client's "rebuild only on TX_CONFLICT" rule depends on; it needs its own timeout and must fail in the safe direction, never becoming a SPOF that wedges boots. D's cache reuse also removes the one extra WoC fetch Build B's precheck added (`getBalance()` per free boot). ~4–6h.
> - **Other Phase-2 fast-follows (deferred, not launch-blocking):** DB-backed *instant* kill-switch runtime toggle (Build C is env-var/redeploy today — fast-follow gives seconds-not-minutes tripping but needs an authed admin route); real low-balance **alerting** via webhook/email (the console alert exists now; the transport is Phase 5 observability); queue-depth/mutex-wait metric; split mutexes (posts vs boots); backpressure on `logPostOnChain`; WoC retry/backoff in double-spend recovery (`wallet.ts:323`); multi-instance double-spend (in-process wallet state — a pre-horizontal-scale gate, already noted below, explicitly NOT a launch blocker).

- [~] **Server-side resilience: unified broadcast + read path (`/api/broadcast` proxy + server wallet reuse).** *(Phase 2 A+B+C DONE 2026-06-16; remaining = Build D + small items — see the status note directly above. The timeout-scope and low-balance sub-bullets below are now DONE; the proxy/failover/cache-reuse sub-bullets are the Build-D spec.)* The server wallet (`wallet.ts`, `onchain.ts`, `boot-orchestrator.ts`) currently hits ARC and WoC directly — none of the client-side mitigations apply. An ARC hang freezes the mutex and blocks ALL posts + free boots platform-wide; a dropped 0-conf chain fan-outs into uncached WoC reads. Build-spec:
  - **`/api/broadcast` proxy** with GorillaPool primary → TAAL ARC fallback on 5xx. All client broadcasters wired via `new ARC('/api/broadcast')`. 10s timeout, structured ARC error passthrough (client's 257/258 classification depends on it), rate limit keyed on pubkey not IP. Motivated by GorillaPool outages 2026-04-08 and 2026-04-14. **Timeout scope = ALL four in-mutex network calls, not just broadcast.** Inside the single held mutex the server wallet makes four un-timed `fetch`/broadcast calls: unspent fetch (`wallet.ts:89`), source-tx-hex fetch (`wallet.ts:167`, once per input), broadcast (`wallet.ts:267`), and the double-spend recovery lookup (`wallet.ts:323`). Any one hanging freezes ALL posts + free boots site-wide for the hang duration (real precedent: GorillaPool outages, April 2026). Apply the same ~10s `AbortController` timeout to each of the four call sites; on timeout, fail cleanly, release the lock, and let the existing retry logic re-run. The read-cache reuse below covers reuse, not the timeout — both disciplines must reach all four sites.
  - **Server wallet reuses the same proxy** (shared broadcaster module, not duplicate SDK default). `wallet.ts:267` and all server tx paths go through the same failover + timeout discipline as the browser.
  - **Server wallet reuses `/api/tx-hex` and `/api/unspent` caches** — via a shared internal cache module, not re-fetching through the HTTP route. `wallet.ts:89,167,323` currently bypass the cache completely; a chain break fan-outs N raw WoC calls per recovery.
  - **Broadcast timeout + queue-depth metric** — log/alert when mutex wait > 5s or queue depth > 5. Early signal of ARC degradation. Today a 30s ARC hang silently freezes the platform with zero visibility.
  - **Low-balance alert on server wallet** — log + optional webhook when balance < 10k sats or `_pendingChange` is repeatedly empty. At $10 float → ~3,700 free boots before exhaustion, no auto-refill and no current visibility.
  - Sequence: proxy first, then server-side reuse, then metric/alert. ~4–6h total work.
- [ ] **Split mutexes: posts vs boots.** Currently posts (OP_RETURN, 1-in 1-out, ~20ms signing) share the same mutex as boot splits (10–15 outputs, ~50ms signing + longer ARC round-trip). Under burst load, a boot queue starves posts. Two separate mutexes (or a priority queue) roughly doubles practical throughput. `wallet.ts:14`. ~1h work.
- [ ] **Backpressure on `logPostOnChain`.** If server wallet mutex queue depth exceeds N, skip the OP_RETURN log (SQLite post still stands, `onchain.ts:48` already tolerates null return). Prevents unbounded queue growth during ARC flaps. ~30min work.
- [ ] **WoC retry/backoff in double-spend recovery.** `wallet.ts:323` currently swallows errors with `/* best effort */` and leaves competing UTXOs un-blacklisted, potentially re-entering retry within the 3-attempt cap. Add retry + backoff matching the client proxy pattern. ~1h work.
- [ ] **Near-instant payment UI via SSE + optimistic updates** — when a boot happens, recipient sees earnings/activity/balance update in ~300ms instead of 15–60s polling. Sender sees own-action effects in <50ms. Showcases BSV speed + agentic fairness as a visible product moment, not a status poll.
  - **SSE endpoint `/api/events?address=...`** using a module-singleton Node `EventEmitter`. Wrap the emit site in a `publishPayout(recipientAddress, payload)` helper so swapping to Redis / Postgres LISTEN-NOTIFY later is one file. Node runtime only (edge kills the singleton).
  - **Emit from `/api/boot-confirm`** right after the `payouts` INSERT succeeds. Payload: `{ boot_event_id, post_id, total, your_share, recipients, ts }`. Dedup on the client by `boot_event_id` so retried confirmations don't fire fireworks twice.
  - **Client**: `EventSource` per open tab, auto-reconnect is free. On event: refetch `/api/earnings` + `/api/balance`, trigger confetti/pulse on balance chip, animate split diagram from post → recipient.
  - **Optimistic own-boot path**: after successful broadcast we already have `rawTx` + txid. Parse own outputs locally, update balance chip and activity immediately. WoC poll reconciles silently on next tick.
  - **Keep the 30s polling** as SSE fallback. SSE is enhancement; polling is ground truth. See DECISIONS.md "Real-time updates".
  - **Ops**: 15s heartbeat comment to survive serverless idle timeouts; in-process emitter works only on single-instance deploys (fine at current scale, revisit on horizontal scale); Railway long-lived Node preferred over Vercel edge for SSE. **Same single-instance constraint binds the server wallet** — its mutex, UTXO reservation (`_reserved`/`_pendingChange`), and double-spend blacklist (`_spent`) are all in-process memory (`wallet.ts:14,65-67`). Two+ instances against one `BSV_SERVER_WIF` can't see each other's reservations and will spend the same UTXOs (failed boots/posts, double-spend errors). Hard prerequisite before horizontal scale-out — not a launch blocker. Cheap first step: a single global advisory lock (DB/Redis) around `buildAndBroadcast`; full fix moves reservation state to shared storage.
  - **Failure handling**: broadcast fail → no optimistic update (we already branch on success); tx replaced/orphaned → WoC poll corrects the optimistic balance; SSE drop → poll fills the gap; boot-confirm fail after broadcast → same issue as today, unchanged.
  - ~3–4h work (endpoint, event bus, client wire-up, fireworks animation). Do after `/api/broadcast` so the broadcast proxy's error codes are stable before SSE consumes them.
- [ ] **Manage Identity card redesign (4-stage roll-out)** — parallel audit from designer + researcher + architect agents (2026-04-15) surfaced 13 interactive controls at primary tier (target 5), semantic duplicates, and real flow bugs. User decisions locked in: adopt Coinbase/Phantom "orange row until backup saved, then gone forever" pattern; skip the in-card AI button (researcher + architect both red-teamed it — every major product keeps AI outside the account menu; key-exfiltration and bad-advice-on-irreversible-actions risks outweigh benefit); rename header to "You". Stages:
  - **Stage 1 — Bug fixes (DONE 2026-04-15):** 8s of cosmetic `delay()` padding removed; backup-warning color unified to amber across chip + modal (was amber/red split). (*MoveAddressModal retry fix noted here was removed in the 2026-06-14 rotation removal.*)

  - **Stage 1b — Remaining bug fixes (DONE 2026-04-16):** `/api/tx-hex` now retries 404s with 2s backoff up to 3 times (~6s budget) to ride out WoC's 2–10s mempool indexing lag on 0-conf chain ancestors. Backup download now requires an explicit "Got it" acknowledgement before `backedUp` flips (green confirmation banner replaces the orange save-CTA in the dropdown). Silent download failures (popup blocker, disk full, CSP deny) no longer masquerade as success.
  - **Stage 2 — Dead-code cuts (DONE 2026-04-15):** removed Paste-recovery-key textarea (redundant with file import), removed Hide toggle inside Show-recovery-key (dead micro-state once revealed in a session). Sparkline kept in dropdown per user preference.
  - **Stage 3 — Merge + reframe (DONE 2026-04-15):** Deposit moved into balance zone as `+ Add funds` button (one click from the chip); modal header renamed "Manage identity" → "You"; Coinbase/Phantom one-time backup banner added to the dropdown — amber "Save your recovery file" pulse until saved + acknowledged, then gone forever.
  - **Stage 4 — ATTEMPTED + REVERTED (2026-04-16):** built the 3-question intent-led layout ("Is my account backed up?", "I'm on a new device", "I think my keys were exposed") replacing the flat You-modal section list. User rejected the approach during live review — the flat list reads faster and feels less like a support FAQ. Reverted via `git restore` before commit; no artifacts in git history. Flat section list is the settled state. **Do not re-queue.**
  - **Pending-payment badge (still wanted, split out from Stage 4):** on-chip/in-balance "$0.12 · 1 pending" badge with honest tooltip about sub-minute confirmation. Track broadcasts from `useBoot` and client-side transfer paths; clear on next balance-poll delta or 90s timeout. ~30–60min. Natural fit once SSE/optimistic work lands — defer until after `/api/events`.
  - **Stage 5 — Earnings-first hierarchy + polish (DONE 2026-04-17):** Full dropdown restructure informed by parallel designer + researcher agent audits studying Apple, Google, Coinbase, Cash App, Phantom, Stripe, and Revolut patterns. Earnings-first hierarchy: all-time earnings (hero number `text-lg font-semibold`, collapsible chart default-open) → activity (2 visible, "View all N" toggle right-aligned in header, Stripe pattern) → balance (demoted to single row with inline "Add funds" link). Protected security status replaced with inline checkmark next to name (X-verified pattern); unprotected keeps full red banner. Font hierarchy two-tier system: static data zinc-500, interactive elements zinc-100 + underline. Section labels standardized to zinc-400 font-medium. Close buttons unified to SVG icons. "Your identity" → "Manage" button. Activity API limit bumped from 10 to 50. EarningsSparkline header removed (parent handles via toggle).
  - **Stage 6 — Amber brand + modal restructure (DONE 2026-04-17):** Full amber rebrand (#f59e0b) across identity card, You modal, UpgradeModal, ChangePassphraseModal, MoveAddressModal — single accent color, gold top stripe, `#0f0f0f` backgrounds. You modal restructured as a clean launcher: Restore extracted to standalone RestoreModal; only recovery key stays inline (read-only). **Mandatory memory clue** on all passphrase flows. **Activity key fix:** added index to React key to prevent duplicate-key errors when multiple payouts share the same timestamp. (*MoveAddressModal, sweep hardening, `verifyMigrationChain`, and rotation-related primitives built in this stage were subsequently removed in the 2026-06-14 rotation removal.*)
  - **Stage 7 — Manage gate + done-state polish (DONE 2026-04-30):** Single-passphrase gate on the You modal: verify once on entry, eligible actions unlocked while modal is open; session destroyed on close OR tab blur (password-manager pattern). Restore row subtitle. **Memory clue input** gets `autoComplete="off"` + `autoCorrect/Capitalize="off"` + `spellCheck={false}`. **Em-dash entity fix.** (*Combined recovery file, MoveAddressModal Stage 3 flow, and rotation-related done-state copy built in this stage were removed in the 2026-06-14 rotation removal. Recovery files are now single-key only.*)

  - **Stage 8 — Identity card deep polish (DONE 2026-05-01):** Full multi-agent review (designer + marketer + architect + code-auditor) of every word, button, click path, and stage. Shipped in eight commits across seven batches, each gated by code-auditor pre-commit verification.

    **Shipped:**
    - **A3 + Bonus (645aec2):** Deleted dead `backupConfirmed` state + render block (~30 lines, orphaned in Stage 6 cleanup). Deleted `src/components/UpgradeModal.tsx` (orphaned since Stage 6, not imported anywhere). Auditor caught and removed an unused `PassphrasePrompt` import in IdentityBar as a bonus.
    - **R4 + R5 partial + R7 + R8 + R10 (bbe8244):** Show recovery key row subtitle → *"Secret key — handle with care"*. Two MoveAddressModal validation errors trimmed (*"Same as your current passphrase"*, *"Add a memory clue — it's your only reminder if you forget."*). Passphrase-stage subtitle → *"Choose a passphrase"*. Empty activity state → *"Your earnings show here — share an idea, or boot posts you like."* Memory clue red helper → *"Only you should know what this means — it's stored unprotected in your recovery file."*
    - **R2 (028658d):** Restore row subtitle → *"Imports posts and earnings from a saved key"* — resolves the "stay on this one" pronoun ambiguity flagged by both designer and marketer.
    - **C1 + C3 + C4 (080596e):** Dropped pulse from "Not protected" banner. Done-state amber block 6 sentences → 3: *"Recovery file downloaded — it has both keys. Keep it safe (cloud, USB) and remember your passphrase. **Without both, you can't get back in.**"* RestoreModal red body drops duplicate sentence. Bonus: removed unused `isIdentityEncrypted` import from RestoreModal.
    - **C6 (db4beba):** Show recovery key panel reworked. Red warning *"Anyone with this key owns your account and any funds in it. Never share it."* above masked key. Replaced two-step Show→Copy with acknowledgement-gated `[Reveal key]` that splits into side-by-side `[Hide key]` `[Copy key]` after click.
    - **A2 (05c6624):** `RestoreModal.onSuccess` now sets `BACKED_UP_KEY` atomically (the file just restored IS the backup). Dropdown banner click handler collapsed to single `handleSaveFile` path — removed the 3-click protected-user detour.
    - **A1 (9785332):** Biggest structural change. Two stacked modals (gate + You modal) → single You modal with locked/unlocked internal states. Body cross-fades on unlock via `animate-[fadeIn_0.2s_ease-out]`. Auto-focus input on locked-state mount. Deleted ~63 lines of separate gate JSX.
    - **Bug fix (4e37f3c):** Move Cancel returns to You modal (matches RestoreModal pattern). `moveCompletedRef` distinguishes Cancel mid-wizard from Continue after success — Cancel just dismisses the wizard; Continue dismisses + re-locks the You modal because the new passphrase invalidates the cached gate session.

    **Explicitly rejected (do not relitigate):**
    - **C2** — Three "Move it somewhere safe (phone, cloud, USB)..." instances stay identical. Designer-validated: temporally distant, consistency = recognisable safety mantra.
    - **C5** — Currency toggle keeps "🐐 Goat / 💵 Noob" labels. Designer-validated: emotional framing is load-bearing.
    - **R1** — Passphrase row subtitle (historical note: was "Move to a fresh key — earnings and posts stay synced"; now reflects encrypt-in-place — no key move).
    - **R3** — ALL-CAPS section labels stay (Stripe/Linear/Vercel pattern; doesn't shout at 10–11px label size).
    - **Passphrase row label** — stays "Passphrase" (not "Upgrade", "Secure", "Protect").

    **Considered, deferred:**
    - **Path B identity-modal consistency refactor (deferred 2026-05-01, commit bd5e5bc):** convert MoveAddressModal + RestoreModal + Show recovery key into inline body-swaps inside the You modal (matching the locked-state pattern). Designer recommended; architect produced a 7-step plan; code-auditor adversarial review found 4 real bugs + 1 missed concern, including a tab-blur fund-loss scenario where interrupting the wizard mid-broadcast would leave localStorage with the OLD key while funds are already on the new address. Deferred because settings is low-traffic, the inconsistency only manifests on rapid cycling, and the risk-of-breaking-blockchain-state-mutating-code-paths outweighs the polish benefit. **Revisit when:** user feedback flags the inconsistency, OR there's bandwidth for a careful Path B implementation with all 5 mitigations + manual end-to-end testing of every wizard stage.
  - **What to preserve (architect red-team, historical note):** C9 backup-warning dot semantics, `getIdentity()` plaintext-preferred fallback ordering (subtle H5 regression surface). (`commitUpgrade` and the migration signature chain were removed in 2026-06-14 rotation removal.)
- [ ] Notification system (bell icon — "anon_x7f2 featured your post", daily earnings summary)
- [ ] Content moderation (report mechanism, basic filtering)
- [ ] Deploy to Railway + custom domain
- [x] Agent chat: dynamic MD loading (reads project MDs at request time, always current)
- [ ] Agent chat: DB query tools (live oracle — real post counts, contributor stats, boot prices)

## Tech Debt — TRACKED

- [x] ~~Optimistic blacklist on boots~~ — **REMOVED 2026-04-13** (replaced by mutex + throttle + 0-conf chaining).
- [x] ~~Confirmed-only filter on consolidation~~ — **REMOVED 2026-04-13** (redundant at 100 sat/kb).
- [x] ~~Server-side source tx cache~~ — **DONE 2026-04-13** (in-memory Map in `/api/tx-hex`, 2000-entry LRU). IndexedDB not needed — the server-side cache solves the WoC rate-limit problem for all clients.
- [ ] **Client-side IndexedDB source-tx cache** — nice-to-have future optimization. Current server-side cache handles the main problem. Client-side cache would eliminate the server round-trip entirely. Low priority.
- [ ] **Refactor `clientSideBoot` + `consolidateUtxos`** — current state still has some duplication across broadcast-result classification blocks. Architecture review (2026-04-11) flagged as frankenstein. Several tech debt items from that review are now resolved — refactor is lower priority. Revisit if/when the file grows further.

## Phase 6.6: Mobile/PWA hardening (E1–E32) — COMPLETE

The E-series (E1–E32, 2026-05-08 → 2026-06-03) hardened the recovery, protect, and install flows for production. E29–E31 (rotation-defence) were subsequently superseded by the full rotation removal (2026-06-14). See SESSION_LOG.md for per-session detail and DECISIONS.md for the locked-in patterns.

- [x] Mobile modal restructure — 6 modals adopt the AgentChat bottom-sheet pattern (LAUNCH_PLAN Bucket 1)
- [x] Welcome gate + install pitch (LAUNCH_PLAN Bucket 3a) — `useStandaloneMode`, `useInstallPlatform`, `InstallContext`, `InstallPitch`, `InstallBookmark`, `HomeScreenWelcomeGate`, `IosStorageToast`, `FirstEarningToast`
- [x] Recovery file hardening (E1–E25) — combined recovery file, iOS Quick Look compatibility (static-render + inverse-noscript + form-control text selection), Web Share API on iOS, lazy backup payload to survive iOS transient activation
- [x] E26 — explicit save acknowledgement instead of auto-download
- [x] E27 — restore-from-encrypted-file adopts the file's passphrase
- [x] E28a/b/c — PWA share fixes for iOS standalone
- [x] E29 — block restore of any key with forward migrations (closed "new device adopts stale key" vector) — **SUPERSEDED 2026-06-14** by removal of rotation; the attack surface no longer exists
- [x] E29a — desktop skips Web Share API
- [x] E30 — stale-key session-lockout (`StaleKeyModal`, `E30_STALE_KEY_ENABLED` flag) — **SUPERSEDED 2026-06-14** by removal of rotation; stale keys cannot exist when the address never changes
- [x] E31 — block rotate-from-stale + `cleanupMigrations` deleted — **SUPERSEDED 2026-06-14** by removal of rotation
- [x] E32 — install pitch UX overhaul: slide-up sheet → bookmark chip pattern, no timer-based dismissal, Android Chrome one-tap restored, centered bookmark, modal-overlap ref-counter, geometry parity with Ask AI pill
- [x] Android device-testing fixes (2026-06-03): UTXO outpoint dedup in `sweepFunds` / `autoTransferFunds` (catches WhatsOnChain duplicate-outpoint responses that produced `bad-txns-inputs-duplicate`); site-wide `vh` → `svh` modal sweep across 7 centered modals (fixes Android Chrome address-bar clip)

## Phase 6.7: Launch-critical deep-audit + device-test fixes (2026-06-15) — COMPLETE

Exhaustive multi-agent deep-audit of the whole rotation-removal + boot-hardening surface, then real on-device QA, then an on-chain money-integrity verification. Closes Phase 1 of the launch-critical plan.

- [x] On-chain extensibility envelope (Phase 1 Step 9b) — shared `onchain-record.ts` `onchainRecord(type, body)` used by both writers (post + boot_split); the `app` literal + `v` version live in one place; reader contract documented
- [x] Deep-audit — 5 cross-commit must-fix bugs, all FIXED: F4 null-wallet free boot burned a grant + recorded a phantom boot; F1 interrupted restore reverted to the OLD key; F2 corrupted-store trap (added SignInModal restore link); F3 corrupt-store auto-gen guard; F6 paid-boot DOUBLE-PAY on weight/price drift → now records from on-chain outputs, client never rebuilds after broadcast. See SECURITY_AUDIT.md "Phase 1 Deep-Audit".
- [x] Device-test fixes (real on-device QA) — `/api/balance` splits confirmed (spendable) vs pending; IdentityBar shows a spendable headline + muted "+X pending" line; FundAddress + `clientSideBoot` + `useBoot` fee-aware (deposit shortfall = price + network fee, provably positive in the insufficient branch); FirstEarningToast "Save now" opens ProtectModal directly (no You-modal hop); ProtectModal + ChangePassphraseModal raised to z-[70] (were painting behind the You modal). NOT money-loss — display/affordability honesty. See DECISIONS.md "Balance shows spendable (confirmed)".
- [x] On-chain money-integrity verification (PASS, mainnet) — audited all 29 `boot_split` txs for the test address vs the fairness config: every boot conserves value (Σinputs = Σoutputs + fee); the paid boot's 5/15/80 split is config-exact (platform = exact 5%); all 29 OP_RETURN records well-formed + consistent; the DB payouts ledger matches the chain to the satoshi. Earnings display showed only a benign +101-sat read-lag (the row exists, id 6347; self-corrects on poll). Core money engine verified correct on real mainnet money.

**Phase 1 (launch-critical) CLOSED. Next: Phase 2 — server resilience.**

## Phase 3: Governance — content moderation + legal (right-sized 2026-06-16) — CODE COMPLETE; legal/lawyer work pending

Right-sized after an owner free-speech discussion (see DECISIONS.md "Thin-core content moderation … REFINED 2026-06-16"). The product is censorship-resistant by design; posts stay on-chain (provable timestamped attribution IS the product). NO editorial moderation, NO hidden-flag/admin/report apparatus (handle the rare case by hand). Rejected + recorded: client-broadcast/faucet (breaks free posting), off-chain posts (kills attribution), OP_RETURN obfuscation (doesn't help, hurts attribution).

- [x] **Thin pre-publish content filter (illegal-floor only) — DONE 2026-06-16.** `lib/content-filter.ts` `screenContent()` in `createPost` before DB insert + broadcast; operator-supplied `CONTENT_DENYLIST` env (not committed); best-effort + extensible; permissive when unset (a "before public launch" operator gate). Unit-tested. The one real guard, because the server broadcasts the OP_RETURN.
- [x] **Plain disclaimer docs — DONE 2026-06-16** (`legal/terms-of-service.md`, `legal/privacy-policy.md`, `legal/permanence-acknowledgement.md`) — lawyer-ready drafts: every operator/jurisdiction field is a `[TODO]`, every hard clause carries a `[LAWYER]` marker, accurate "hidden-not-deleted" verbs, only the moderation that actually exists. Reviewed line-by-line (Hard Rule #6 holds).
- [x] **Disclaimer surfacing — DONE 2026-06-16.** `/terms` + `/privacy` static pages (render the drafts behind a DRAFT banner via a small no-dependency markdown renderer; internal `[LAWYER]` notes stripped, `[TODO]` placeholders kept; build-time file read → both pages prerender static). "Terms · Privacy" links in the You modal + the Ask-AI modal footer. One-time pre-first-post **permanence acknowledgement gate** (`PermanenceGate`, localStorage `opencook_permanence_ack`) — affirmative consent at the legally-meaningful first-post moment, preserves 2-click onboarding (one tap, once).
- [ ] **OWNER, before public launch (not a build blocker):** (a) set `CONTENT_DENYLIST`; (b) ~1hr lawyer on the 3 hard risks — GDPR-erasure-vs-immutable-chain wording, CSAM/operator-as-broadcaster exposure, money-transmitter characterization; (c) register a DMCA agent + fill the doc `[TODO]` placeholders.

## Phase 7: The Recursive Model — PLANNED

- [ ] Post-to-project spawning
- [ ] Template system for new instances
- [ ] Yours Wallet integration via @1sat/connect for power users

## Threading (OpenBook fork) — SERVER SIDE COMPLETE, UI NOT BUILT

> The prerequisite for the token tree in TOKENS.md — a token attaches to a thread root, so
> there must be thread roots. Spec + rationale: THREADS.md. Decisions: DECISIONS.md "Threading".

- [x] Migration: `parent_id` + denormalised `root_id`, backfill, 2 indexes (`db.ts`)
- [x] `createPost` accepts `parent_id` — parent looked up not trusted, root resolved, one transaction
- [x] Feed reads filtered to roots only (shared `ROOTS_ONLY`); new `getThread` + `getReplyCounts`
- [x] On-chain `id` + `parent` on the post OP_RETURN, forwarded by the anchor sweep too
- [ ] **UI: thread view + reply composer** — the only remaining step; nothing is user-visible until it lands
- [ ] Thread-aggregated boot counts (deliberately deferred — touches `weights.ts` + bootboard semantics)
- [ ] Settle the carried question: does ordinary posting become paid? (minting a ticker vs posting)

## Open Source — COMPLETE

- [x] Clean up repo for public release
- [x] Ensure AI context files are comprehensive
- [x] Choose license — MIT
- [x] GitHub public release — `github.com/Challotes/opencook` confirmed PUBLIC (2026-06-26)
