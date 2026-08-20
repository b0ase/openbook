# $OpenBooks — AI Context File

> **If you're an AI reading this:** This file is your onboarding. Read it fully before writing any code.
> After completing significant work, update the relevant context files (DIRECTION.md, DECISIONS.md, ROADMAP.md) with what you changed and why.

## What This Is

A board for ideas where the record of who wrote what is public, permanent, and belongs to the person who wrote it. Every post is anchored on-chain (BSV) **and mints its author one token** — that part is live. Threads can be named with a `$Ticker`, which gives them an address and gives the token a readable name.

**Tagline:** "Own what you post."

⚠ **THIS FILE IS LOADED INTO THE USER-FACING AGENT** (`src/data/agent-prompt.ts` reads it on
every question), so a stale line here is not an internal inaccuracy — the agent will say it to
users. Two things were corrected on 2026-08-14 for exactly that reason:

- The name is **$OpenBooks**, plural, matching `openbooks.space`. It was `$OpenBooks` until then.
- The tagline was *"A platform that builds itself, then lets anyone do the same"* with the
  subtitle *"Agentic Fairness"*. Both were rejected by the owner. "Builds itself" is not true —
  somebody has to build the platform others then use. And "fair" is not the pitch: nobody is
  looking for a fair place to post, they want somewhere good and worth their time. Fairness
  describes the payout arithmetic, which is plumbing. **The proposition is ownership.**

## Toolkit

This project is built using the **bOpen.ai toolkit** (agents, skills, plugins). bOpen is the tooling, not the product. The product is $OpenBooks.

## Architecture

- **Framework:** Next.js 16 (App Router) + React 19.2 + TypeScript + Tailwind CSS v4
- **Build:** Turbopack (dev + prod), React Compiler enabled (`reactCompiler: true` in `next.config.ts`)
- **Linter/Formatter:** Biome (`biome.json`) — replaced ESLint 2026-03-25. Full auto-format pass applied 2026-04-10 (0 lint errors across 69 files).
- **Database:** SQLite (better-sqlite3) for local dev, file: `local.db`
- **Blockchain:** BSV via `@bsv/sdk` — keypair generation, signing, on-chain logging
- **Identity:** Auto-generated BSV keypair stored in browser localStorage
- **Styling:** Dark theme (zinc/black palette), Telegram/X/GPT hybrid UI

## Key Files

### API Routes

- `src/app/api/posts/route.ts` — Feed polling (GET, ?since_id for incremental updates)
- `src/app/api/boot-shares/route.ts` — Contributor shares + boot price for client-side tx building
- `src/app/api/boot-confirm/route.ts` — Records boot after client broadcasts (rawTx + local P2PKH parsing, self-authenticating hash(rawTx)===txid check, ARC re-broadcast safety net, replay protection, rate limiting). **Booter auth (Step 7):** requires an ECDSA signature over `boot:<postId>:<txid>` (`boot-message.ts`); the credited address (`bootboard.boosted_by` + `boot_grants`) is DERIVED from the verified pubkey, never client-supplied — closes boot-attribution forgery. **Payouts are RECORDED FROM the verified on-chain outputs (the `hash(rawTx)===txid` self-auth makes the tx trustworthy), NOT a server-recomputed split (Finding 6, 2026-06-15):** recomputing rejected legitimate price/weight drift, and a client retry then minted a new txid that DOUBLE-PAID. The one enforced invariant is a conservation floor — the platform must receive ≥ `floor(bootPriceFloor × platformCut) − 2` sats, else `422 BOOT_UNDERPAID`. See DECISIONS.md "Paid-boot confirm records from on-chain outputs".
- `src/app/api/boot-status/route.ts` — Free boots remaining + boot price for a user
- `src/app/api/earnings/route.ts` — Total earned, activity feed, earnings history for chart
- `src/app/api/agent/route.ts` — Streaming agent chat (SSE, rate-limited)
- `src/app/api/transcribe/route.ts` — Voice-to-text proxy: receives recorded audio (multipart `audio`) from the compose-box mic, forwards to Groq Whisper (OpenAI-compatible), returns `{ text }`. Cost guards mirror `/api/agent` (per-IP rate limit + concurrency cap + `TRANSCRIBE_DAILY_LIMIT` daily circuit-breaker); 503 if `GROQ_API_KEY` unset. The "record + server STT" mic — see DECISIONS "Mic: record + Groq Whisper".
- `src/app/api/tx-hex/route.ts` — WhatsOnChain raw-tx proxy (cached, retries, stale fallback)
- `src/app/api/balance/route.ts` — WhatsOnChain balance proxy (10s cache, 120/min, graceful fallback on 429). Splits UTXOs by `height`: returns `balance`=`confirmed` (spendable, what the UI shows as the headline) + `pending` (0-conf change/earnings). NOT a confirmed+unconfirmed sum — that overstated spendable funds (see DECISIONS.md "Balance shows spendable (confirmed)").
- `src/app/api/unspent/route.ts` — WhatsOnChain UTXO proxy (3s cache, 180/min, retries with stale fallback)
- `src/app/api/health/route.ts` — Phase 5 observability. Read-only operational snapshot (wallet balance + `low`, pending-anchor count + `backlogHigh`, daily-spend status + `ceilingReached`, kill-switch `spendDisabled`, `addressConfigured`). Returns **200 healthy / 503 when a critical condition trips** so a free uptime monitor (UptimeRobot) emails the operator on non-200 — no Slack/Discord/email dependency in the app. Snapshot cached 10s (so it can't fan out to WoC), optional `HEALTH_TOKEN` gate, rate-limited 30/min. **Exposes NO secrets** — never the WIF or the server ADDRESS (only `addressConfigured: boolean`). A failed WoC balance read is a non-critical issue flag (won't false-page on upstream blips). In-app webhook/email alerting was deliberately deferred (owner uses neither Slack nor Discord; the uptime-monitor-on-/api/health covers launch).
### Server Actions & Data

- `src/app/actions.ts` — Server actions. Reads (no signature): getPosts (newest, id DESC), getNewPosts (id > since), getUpdatedPosts, getOlderPosts (id < before, DESC — LIVE scroll-up), getOldestPosts (id ASC — ORIGIN/Genesis jump), getForwardPosts (id > after, ASC — ORIGIN read-forward), getBootboard, getPostCounts (lightweight `{id, boot_count}` for the feed's live authoritative boot-count refresh — see DECISIONS "Live boot counts"). Mutations (signature-verified): createPost, bootPost. **Threading (THREADS.md, server side only — no UI yet):** every feed read is filtered by the shared `ROOTS_ONLY` (`p.parent_id IS NULL`) constant — **miss it on one and replies leak into the feed**, worst on `getNewPosts` (polled every 5s, so a reply pops into every open feed). `getOlderPosts`/`getUpdatedPosts`/`getPostCounts` need no filter (the first delegates to `getPosts`; the others take explicit id lists). New read: `getThread(rootId)` (whole thread, root first, one indexed `root_id` lookup — not a recursive walk). `reply_count` rides the `POST_SELECT` join like `boot_count` (no second round-trip, can't drift from the row beside it), and `getPostCounts` returns it too — **replies have no other route to the client**, since `getNewPosts` filters them out and `getUpdatedPosts` only carries tx_id gains, so without that channel a root's "N replies" would sit stale until a reload. `createPost` takes an optional `parent_id` form field: the parent is **looked up, never trusted** (it is not covered by the post signature) → `invalid_parent`, and insert + `root_id = id` run in ONE transaction (a root's id can't be known before insert).
- `src/lib/ticker.ts` — **The `$Ticker` parse rule — CONSENSUS-CRITICAL, not a UI detail.** A ticker names a thread, and under TOKENS.md naming an unclaimed one is a founding act that will eventually cost money and mint the genesis token — so **ambiguity resolves toward NOT a ticker**: `$50`, `$1.50`, `US$20`, `foo$bar` and a bare `$` never match (the required leading LETTER is what excludes prices). Canonical form is UPPERCASE, so `$openbook`/`$OpenBook`/`$OPENBOOK` are ONE claim — case-sensitivity would allow a visually identical second claim, the impersonation vector BSV-21's non-unique `sym` leaves open. Pure and dependency-free so rendering, registration and any future chain indexer share it. `findTickers` returns offsets so renderers slice rather than re-scan with a second pattern that could drift. 39 unit tests, weighted toward what must NOT parse. **Also owns the one address of every thread: `tickerHref(path)` + `ROOT_HREF`.** The root token's address is the BARE SITE (`openbooks.space`, not `/$openbooks`) — the feed and `$OpenBooks`'s thread are one view, so they get one URL. `tickerHref` keys on the LAST segment (the only one that decides which thread opens), so the root collapses to `/` only as a leaf and `/$openbooks/$test` is untouched. **Mint thread links through it, never by hand** — a hand-built `/${path.map(tickerSlug).join("/")}` is exactly how `/$openbooks` used to reach the address bar. `/$openbooks` and the pre-plural `/$openbook` stay valid and 307 to `/` via the catch-all's `redirectIfRoot`. See DECISIONS.md "The root token's address is the bare site".
- `src/lib/db.ts` — SQLite setup (WAL, foreign keys, auto-migration, indexes, boot_grants + payouts tables)
- `src/lib/rate-limit.ts` — In-memory sliding window rate limiter
- `src/lib/onchain-record.ts` — `onchainRecord(type, body)`: the shared envelope (`{ v, app, type, …body, ts }`) for EVERY app OP_RETURN record (post + boot_split). Single source of the `app` literal + `v` version (de-risks the Phase-7 rename). Holds the **reader contract** (ignore unknown fields, key on `(app, type)`, missing `v` = legacy, bump `v` only on breaking changes) and the `ts`-is-the-writer's-clock caveat. Unit-tested in `onchain-record.test.ts`. To add a new on-chain field later: add it to the relevant builder's `body` — backward-safe, no `v` bump.
- `src/lib/boot-audit.ts` — `bootAuditPayload(...)` builds the boot_split record via `onchainRecord`. Single source of truth shared by BOTH boot tx builders (`boot-payment.ts` server-funded, `client-boot.ts` client-funded) so the on-chain shape can't drift. Unit-tested in `boot-audit.test.ts`.
- `src/lib/boot-message.ts` — `bootConfirmMessage(postId, txid)` → `boot:<postId>:<txid>`, the canonical string the booter signs for `/api/boot-confirm`. Single source of truth shared by the client (`useBoot`) and server (boot-confirm) so the signed message is byte-identical. Unit-tested (incl. sign↔verify round-trip) in `boot-message.test.ts`.
- `src/lib/free-boot-cap.ts` — Per-IP cap on SERVER-FUNDED free boots (`tryConsumeFreeBootForIp`, 40/IP/24h, reuses rate-limit.ts). Additive defense behind the per-identity `boot_grants` cap, bounding the "fresh identity per incognito tab" server-wallet drain. Fails toward PAID, never fail-open. Consulted by `bootPost` only when the per-identity grant would make the boot free. Unit-tested in `free-boot-cap.test.ts`.
- `src/lib/server-spend-budget.ts` — In-memory daily server-wallet spend ceiling (`hasDailyBudget`/`recordDailySpend`, env `SERVER_DAILY_SPEND_SATS`, ~$0.20/day default). Caps total server spend/day across post on-chain logging AND free-boost payouts (shared wallet) — the aggregate backstop behind the per-IP caps. Checked on accept (refuse / route-to-paid), recorded on actual spend. In-memory by design (Phase 4 — a redeploy can over-spend ~$0.40 once, trivial). The durable anchor sweep RECORDS but never GATES (already-accepted posts must still anchor). Unit-tested.
- `src/lib/utils.ts` — Shared utilities (generateAnonName, cn helper)
- `src/data/agent-prompt.ts` — Dynamic agent prompt builder (loads MDs at request time)
- `src/lib/install-pitch.ts` — Pure 5-condition visibility-gate predicate for the install pitch (backedUp + protected + not-standalone + supported-platform + not-engaged). Returns boolean. Unit-tested in `src/lib/install-pitch.test.ts`.
- `src/lib/in-app-browser.ts` — In-app social-WebView detection. `classifyInAppBrowser` / `isInAppBrowser` / `detectMobileOS` are pure + SSR-safe (UA string only): self-tagging apps (Instagram/FBAN/Twitter/…) + a crawler-exempt list (checked FIRST) + an iOS/Android bare-WebView fail-safe backstop. **`isInAppBrowserClient()`** is the browser-only variant (reads `window`) that ALSO catches **Telegram-iOS via `window.TelegramWebviewProxy`** — Telegram's iOS UA is byte-identical to Safari, so the UA path can't see it (confirmed on the owner's device via inappdebugger.com). Consumed CLIENT-SIDE by `IdentityContext` (`isReadOnly = isInAppBrowserClient() && !detectStandalone()`) — the server no longer does in-app detection. Unit-tested in `in-app-browser.test.ts`.
- **Governance (Phase 3 — right-sized to the free-speech ethos; see DECISIONS.md "Thin-core content moderation … REFINED 2026-06-16"):** `src/lib/content-filter.ts` — `screenContent()` pre-publish screen (ILLEGAL-FLOOR only, NOT editorial) called in `createPost` BEFORE the DB insert/broadcast (the only point that can stop content reaching the immutable chain); operator-supplied `CONTENT_DENYLIST` env, NOT committed; best-effort + extensible; permissive when unset; unit-tested. `src/lib/legal-doc.ts` — `cleanLegalMarkdown()` strips internal `[LAWYER]` notes for the public legal pages. `legal/*.md` — lawyer-ready DRAFT ToS/Privacy/Permanence docs (all operator/jurisdiction fields are `[TODO]`; hard clauses `[LAWYER]`-marked). `src/app/{terms,privacy}/page.tsx` + `components/LegalDoc.tsx`/`LegalPageShell.tsx` — static legal pages (build-time `.md` read, no markdown dep). `components/PermanenceGate.tsx` — one-time pre-first-post permanence acknowledgement (localStorage `opencook_permanence_ack`, wired in `PostForm`). "Terms · Privacy" links live in the You modal + Ask-AI footer. NO editorial moderation, NO hidden-flag/report apparatus (deliberately deferred — handle by hand).

### Pages & Components

- `src/app/page.tsx` — Main entry (server component; **static/ISR, edge-cacheable** — `revalidate=10`, no header reads). In-app-browser handling is entirely CLIENT-SIDE now (in `IdentityContext`), so this page just fetches posts/bootboard and renders `<Feed>`. See DECISIONS "In-app browsers ... read-only live feed".
- `src/app/Feed.tsx` — Client orchestrator: polling, optimistic posts, and the two-mode feed (see DECISIONS "Feed: LIVE/ORIGIN modes + upward infinite scroll"). **LIVE** (default): lands on the newest (bottom), or a returning-user's first-unread post via a frozen `firstUnreadId` + `opencook_last_read_id` localStorage marker; scrolling UP auto-loads older posts (`getOlderPosts`) via a top IntersectionObserver sentinel (1000px top rootMargin) with **bottom-relative scroll anchoring** (`prependPrevHeightRef` → `el.scrollTop += scrollHeight−before` in a pre-paint layout effect keyed on `[olderPosts, liveHasMore]`; synchronous `olderLoadingRef` lock). **ORIGIN** (via the Genesis button `handleGoOrigin`, cross-fade): loads the oldest window (`getOldestPosts`), founding block + post #1 at top, scroll DOWN appends `getForwardPosts` (append = jank-free). `handleGoLive` cross-fades back and resets the LIVE window. Polling `paused` in ORIGIN.
- `src/app/Header.tsx` — Top bar with logo, genesis nav, identity chip
- `src/app/PostList.tsx` — Post rendering, BootButton, Genesis anchor. Mode-aware (`mode` prop): the static founding block (`<Genesis>`) renders at top only in ORIGIN, or in LIVE **once `liveHasMore` is false** (post #1 reached) — mutually exclusive with the LIVE top-load sentinel (so the founding block never sits adjacent to mid-history and can't be yanked by a prepend). ORIGIN renders a bottom forward-sentinel. Unread divider before `firstUnreadId` (LIVE). Unread observer `.observe` is gated to LIVE + `post.id >= oldestServerId` — bounds the observed set to the newest window so deep scroll-up stays cheap (no windowing needed at launch scale).
- `src/app/PostForm.tsx` — Compose box (enter-to-post, voice-to-text, agent chat trigger). Takes optional `parentId` (posts as a REPLY), `compact` (drops the footer row), `placeholder`. The submit pipeline is shared deliberately — a reply is a post, so it gets the same signing, permanence gate, sign-in gate and on-chain anchoring; a second composer would have been two places to keep those in step.
- `src/app/PostText.tsx` — Renders post body text with `$Ticker` as a clickable link to the thread it names. **Splits on `findTickers`' offsets, never a second regex** — a renderer with its own pattern would eventually disagree with the one deciding what gets CLAIMED. Every ticker in an existing post resolves, because registration happens at post time; pre-registry posts are the exception the click handler tolerates.
- `src/app/PostContent.tsx` — A post's rendered body (author line, content, link preview), extracted from `PostList` so `ThreadView` renders posts identically. What differs between them (unread observer, Genesis badge, boot column, the `<article>` wrapper) stays with the caller; `badge` is a slot for the caller's chip.
- `src/app/ThreadView.tsx` — Thread overlay (THREADS.md step 4). **An overlay, NOT a third feed mode** — the feed's LIVE/ORIGIN machinery (prepend anchoring, landing, two sentinels, unread watermark) all assumes the scroll container holds the root feed, so a third mode would have put every one of those invariants in play for a feature needing none of them. Mounts over the feed with its own scroll container; the feed keeps polling underneath and needs no scroll restoration on close. Root + replies via `getThread`, 5s poll (skipped when the tab is hidden), optimistic replies, Escape to close, boot buttons on every row. **Replies target the ROOT, not the tapped post** — the schema stores arbitrary depth, but a flat render with a per-reply reply button would silently produce nesting the UI can't show.
- `src/app/IdentityBar.tsx` — Identity chip + You modal. Amber brand theme (#f59e0b). Earnings-first hierarchy: all-time earnings (hero) → activity (2 visible, "View all" toggle) → balance (demoted, inline "Add funds" link). Protected state = inline checkmark (X-verified pattern); unprotected = red banner (static dot, no pulse) → opens `ProtectModal` (encrypt-in-place flow). **Locked-state You modal:** the You modal opens locked for protected users (`manageAuthed === false`) showing a passphrase prompt as the body. On unlock, the body cross-fades to the rows (Save / Passphrase / Restore / Show recovery key). One container, two states; same modal, body swap with `animate-[fadeIn_0.2s_ease-out]`. Session destroyed on modal close OR tab blur (password-manager pattern). Show recovery key + Restore still re-prompt (defense-in-depth on highest-stakes paths — see DECISIONS.md). Show recovery key panel: red warning (*"Anyone who has this key controls your account and any funds in it. Never share it — not with support, not with friends, not with anyone."*) + acknowledgement-gated Reveal → side-by-side Hide/Copy. The in-app reveal is the only WIF surface that retains a Copy button — the manage gate + acknowledgement is sufficient defense for an in-session reveal; downloaded files have Copy buttons removed from all WIF surfaces (see backup-template entry). Earnings poll 30s — full feed when dropdown open, summary only when closed. Passphrase row icon goes neutral (zinc-400) when protected — color is reserved for active warnings (red unprotected, amber for unsaved backup). `closeDropdown` resets all sub-disclosures (`showAdvanced`, `keyRevealed`, `copied`, `activityExpanded`) so reopen always starts in default state. Currency display defaults to dollars (Noob) always — sats (Goat) is opt-in via the toggle, no protection-aware auto-flip (removed 2026-06-26). **Locked-state chip is invisible** — the chip renders the cached anon name (from `getStoredAnonName()` reading the encrypted store's plaintext `name` field) so the site looks signed in even when locked. Clicking the chip while locked opens `<SignInModal>` (centered modal, not the You modal). The previous ambient pill / shake / `LockedClickCatcher` machinery has been replaced — see DECISIONS.md "Sign-in trigger: centered modal, no global catcher".
- `src/components/RestoreModal.tsx` — Standalone restore-from-device modal (extracted from IdentityBar). Accepts encrypted recovery files only — legacy plaintext files and any file lacking `fileVersion: 1` are rejected with an `unsupported_version` error (intentional "start clean" policy; see `restore-from-file.ts`). When restoring from an encrypted file, the passphrase the user types to decrypt becomes the passphrase guarding the new identity going forward via `importEncryptedIdentity` (the file's hint is preserved too). Save current key prompt before import (explicit "Save current key" / "Skip" with two-step skip confirmation); Save uses `shareOrDownloadBackup` (Web Share API on iOS, `<a download>` fallback elsewhere). The outgoing backup payload is built lazily in a `useEffect` so the Save click handler can call `shareOrDownloadBackup` synchronously (iOS transient activation can't survive an `await encryptWif` before share). Wired to `blockSessionClear()` on the doImport / performImport / handleSaveOldKey paths to prevent iOS system sheets from torching the modal mid-flow. Parent's `onSuccess` no longer dismisses the modal — done state stays visible until the user taps Got it.
- `src/app/Bootboard.tsx` — Pay-to-feature spotlight (live timer, shake/glow animations)
- `src/app/Manifesto.tsx` — Vision TLDR block; rendered by `PostList` as the feed's top cap (in ORIGIN, or in LIVE once post #1 is reached). Was previously wrapped by a `Genesis.tsx` component that also rendered a hardcoded founding-conversation sample; that sample + its `data/genesis.ts` were DELETED 2026-08-03 — the real founding conversation now lives in the feed as seeded genesis posts, so the hardcoded copy was redundant.
- `src/app/AgentChat.tsx` — AI Q&A modal (streaming via /api/agent). Pill carries a small decorative GitHub octocat (14x14, `text-zinc-300` rest, `text-amber-200/70` during `highlight` state to harmonize with the amber pulse) AFTER the "Ask AI" label — purely a visual signal, not a separate click target. The pill click still opens the modal as it always did. Modal has a centered open-source footer below the input row (`border-zinc-800/50`, `text-xs text-zinc-300`) with the repo link + tagline *"The code is open."* + `↗` arrow. Casual users notice nothing; investigators see the icon → click pill → see the link in the modal footer → click through. The icon is shown in BOTH normal and highlight states because the manifesto's "Chat with the agent" CTA puts the pill into highlight, and that's exactly when the open-source signal is most contextually relevant. Don't make the pill icon a separate click target — that would split the pill into two tap targets and break the affordance. See DECISIONS.md "GitHub link: pill tease + modal footer".
- `src/app/FundAddress.tsx` — Centered Deposit modal matching the You modal / SignInModal shell (`max-w-sm`, gold top stripe, `border-amber-400/20`, `#0f0f0f` bg). Body: 180px QR code (`qrcode.react` SVG, white-on-black, scannable across all wallets), balance + boot cost breakdown (when bootPrice context exists with shortfall in amber), click-to-copy address row, primary Copy Address button. Closes on backdrop click + close X. **Fee-aware (Step B, 2026-06-15):** takes an optional `fee` prop (the network fee on top of bootPrice, surfaced by `clientSideBoot` on `insufficient_funds`); shows a "Network fee" row and measures the top-up shortfall against `bootPrice + fee` so it can't say "you have enough" after a real boot failure. `FundAddress.balance` = confirmed/spendable (≠ `clientSideBoot`'s internal all-UTXO `balance` — see DECISIONS.md semantics note). **Value-gate (2026-06-29, the detection-independent funds floor):** the deposit QR/address is HIDDEN behind a "Save your account first" panel until `backedUp` (read from `useInstallContext`) — so real money can't land on an unrecoverable key (an in-app throwaway, or any browser whose storage later clears), *even if in-app detection fails entirely*. The panel's "Save my account" button calls the optional `onSecure` prop (wired to `openProtectModal` at the IdentityBar deposit site). `backedUp` (from `useInstallContext`) is a plain `boolean` that defaults to `false` (SSR + pre-save) → gate shown (safe); it flips true only once a recovery file is saved. See DECISIONS "In-app browsers ... read-only live feed".
- `src/app/layout.tsx` — Root layout (metadata, fonts). Note: the provider stack (`BootProvider` → `IdentityProvider` → `InstallProvider`) is mounted in `Feed.tsx`, not here.
- `src/app/error.tsx` — Error boundary
- `src/components/PassphrasePrompt.tsx` — Reusable passphrase input with hint display
- `src/components/ProtectModal.tsx` — "Protect" flow for unprotected accounts. Collects a passphrase and calls `encryptInPlace` — the existing key/address is encrypted in localStorage with no rotation, no sweep, no migration. Same key forever; passphrase wraps it. On success emits a recovery file (`pathType: "save"`) and updates the global `backedUp` flag only on explicit save acknowledgement. Opened by IdentityBar when the user clicks the unprotected red banner.
- `src/components/ChangePassphraseModal.tsx` — Change passphrase flow (verify current → enter new → backup, or new → backup when `preVerifiedPassphrase` is passed in from the manage gate). Calls `changePassphrase` — re-encrypts the SAME key under the new passphrase. Address and key material are unchanged. After success transitions to a `'done'` step showing `Download again` + `Got it`; `doneBackup` state captures the `BackupData` so re-download is available. Recovery file uses `pathType: "save"` (single key, single address — no previous-key block).
- `src/components/AnimatedBalance.tsx` — Animated balance counter (count-up, green flash)
- `src/components/EarningsSparkline.tsx` — Step-function area chart (pure SVG)
- `src/components/icons/BootIcon.tsx` — Boot emoji icon
- `src/components/BootToast.tsx` — Transient boot error toast (retry action, auto-dismiss)
- `src/components/SignInModal.tsx` — Centered modal opened by `requireIdentity()`. Mounted inside `<IdentityProvider>` in `Feed.tsx`. Container mirrors the You modal locked-state: `max-w-sm`, gold top stripe, `border-amber-400/20`, header with "Sign in" title + close X. Body: full-width passphrase input, "Need a reminder?" two-step click-to-reveal hint (`💡 {hint}` in amber left-border treatment), Cancel + Sign in buttons in a `flex-1` row. On success calls `unlockIdentity()` + `updateIdentity()` then `closeSignIn()`. Wrong-passphrase fires local shake (NOT context) + "Wrong passphrase, try again." error. Closes on backdrop click, Escape, OR tab blur (password-manager parity — clears all input state). No auto-replay: caller retaps action after signing in.
- `src/components/HomeScreenWelcomeGate.tsx` — First-load gate shown only in PWA standalone mode on a tab that has no identity yet. **Restore-only by design** (no auto-generate path in the PWA sandbox): routes between "Upload your saved file to access" (opens `RestoreModal` → `parseRecoveryFile`) and "I don't have a recovery file" (instructional — set up in Safari first). The big OpenBooks wordmark renders at the same size/colour/position across all three modes (buttons / passphrase / no-file), top-anchored so it doesn't shift between them.
- `src/components/InAppPromptModal.tsx` — The "open in your browser" modal shown when a read-only (in-app) user attempts any WRITE action — post/boost/reboot (via the `requireIdentity()` read-only branch) or the profile chip + "Add funds" (via explicit `isReadOnly` gates in IdentityBar). Reading/scrolling never opens it. Centered modal mirroring `SignInModal`'s shell; reuses `InAppBrowserCta`; mounted once in `Feed.tsx` beside `<SignInModal>`. Body holds the "Not in an in-app browser? Continue anyway" misdetect escape (`dismissReadOnly`). No crypto jargon ("account"/"earnings"). Touches no identity/spend surfaces. (Replaced the deleted server-side `InAppBrowserSplash` + `InAppStandaloneGuard` when in-app handling moved client-side — see DECISIONS "In-app browsers ... read-only live feed".)
- `src/components/InAppBrowserCta.tsx` — The CTA used inside `InAppPromptModal`. Android: an "Open in Chrome" `intent://` button (routes out of the WebView → Chrome, which can then open the installed PWA via its WebAPK intent filter). iOS/other: a copy-link button + paste-into-Safari instructions (no programmatic redirect exists on iOS). Touches no identity/spend surfaces.
- `src/components/IosStorageToast.tsx` — Transient warning shown to iOS standalone PWA users about ITP storage clearing. Sequenced behind any other modal flow per LAUNCH_PLAN D4.
- `src/components/FirstEarningToast.tsx` — One-time celebratory toast when a user's first payout lands. Suppression key `opencook_first_earning_save_dismissed_until` (ISO timestamp), 48h backoff whether the user taps Save or Later. CTA flows into the save-recovery-file path.
- `src/components/InstallPitch.tsx` — Two-variant install-pitch component. `variant="inline"` renders the row inside the You modal done-state (one-tap platforms fire `promptInstall` directly; manual-instructions platforms open the slide-up sheet). `variant="banner"` mounts globally in `Feed.tsx` and drives the slide-up sheet via `installSheetMode` from `InstallContext`. Sheet has a chevron-minimise to `<InstallBookmark>` — no timer-based dismissal anywhere. See DECISIONS.md "Install pitch surfaces — no timer-based dismissal".
- `src/components/InstallBookmark.tsx` — Minimised state of the install pitch. 34×34 **bare** button wrapping a 30px OpenBooks app icon (`/icon-192.png`; no zinc box — removed 2026-06-26; an app icon in a zinc container looked odd), `mt-1` baseline offset so it still aligns with the Ask AI pill, centered in the PostForm footer's `grid-cols-3` row. Tap re-opens the slide-up sheet. Highlight flash on sheet→bookmark collapse = an amber `drop-shadow` glow (hugs the icon's rounded shape) + `scale-110`. The footer grid is `overflow-visible` at rest so the glow isn't clipped (it overlaps the attribution line, which is intended) and only `overflow-hidden` during the keyboard-collapse.
### Universal pattern: transaction action requires sign-in

Any action that needs a signed BSV identity (post, boot, tip, future features) follows this one-line pattern at the top of its handler:

```ts
const { identity, requireIdentity } = useIdentityContext();
if (!requireIdentity() || !identity) return;   // opens SignInModal if locked, returns false
// identity is non-null here
```

`requireIdentity()` returns `true` if signed in, otherwise calls `openSignIn()` and returns `false`. The `|| !identity` is a TypeScript narrowing guard. Site looks 100% normal locked — boot buttons not disabled, textarea always enabled, no ambient pill, no shake. Tap → modal opens → user signs in → modal closes → user retaps. Adopted in PostForm `submitForm()`, PostList `BootButton.handleBoot()`, Bootboard `HistoryRow.handleReboot()`. Future toolkit features inherit the pattern with one hook + one line. Read-only actions (AI chat, scrolling, reading posts) NEVER trigger sign-in — that was the explicit reason the previous global `LockedClickCatcher` was deleted.

### BSV Services

- `src/services/bsv/identity.ts` — Keypair generation, signing, encrypted storage. Key functions: `getIdentity`, `signPost`, `encryptInPlace` (adds passphrase protection to an existing unencrypted key — address unchanged), `changePassphrase` (re-encrypts the same key under a new passphrase — address unchanged), `importEncryptedIdentity` (restore from an encrypted recovery file), `unlockIdentity`, `derivePubkeyFromWif`. The key/address never changes after generation.
- `src/services/bsv/crypto.ts` — AES-256-GCM encrypt/decrypt for WIF keys (Web Crypto API)
- `src/services/bsv/backup-template.ts` — Self-contained HTML recovery file generator + `downloadBackup(data)` / `getStoredHint` utilities. `BackupData.pathType` is required (`"save" | "restore-pre"`); no `oldAddress` or `oldWif_encrypted` fields — files are single-key only. Files are stamped with `fileVersion: 1` (`RECOVERY_FILE_VERSION`). HTML template structure: title → subtitle (*"Keep this file somewhere only you can find it."*) → offline badge → metadata card (Name / Address with inline Copy / Saved) → context block → body section (encrypted: passphrase input + decrypt → "Key unlocked" header + WIF block) → footer (monospace stamp `Recovery file · <pathType> · saved <date>` + opencook.fun link). WIF labels use "secret key" terminology — matches the `IdentityBar` row subtitle *"Secret key — handle with care"*. **Static-render for iOS Quick Look (2026-05-04, refined 2026-05-18):** name, address, saved date, plaintext WIF, hint, and footer stamp all render statically in HTML at template-build time. Dates use fixed `en-US` locale for stable output. **E25 (2026-05-18) — inverse-noscript pattern for iOS Quick Look:** encrypted-variant "Your keys are safe but this preview can't decrypt them" banner is a `<div id="quicklook-notice">` visible by default; `hideQuickLookNotice()` IIFE hides it at script load. **E25 — `<input readonly>` / `<textarea readonly>` for tap-to-select in Quick Look.** **`copyText()` reads `el.value` for form controls, falls back to `el.textContent` for spans.** **Do not pass filenames to `downloadBackup`**, **do not re-add Copy buttons on WIF surfaces**, **do not re-introduce the green "Private & Offline" banner**, **do not revert the `<noscript>` pattern**, **do not switch addresses or WIFs back to spans/divs** — see DECISIONS.md "Backup file audit & overhaul" + "iOS Quick Look noscript / input-readonly pattern".
- `src/services/bsv/restore-from-file.ts` — Pure recovery-file parser (`parseRecoveryFile`). Accepts files with `fileVersion === 1` only. Rejects plaintext files and any file missing the version stamp with `unsupported_version`. Supports the marker-block format. Used by `RestoreModal` and `HomeScreenWelcomeGate`.
- `src/services/bsv/client-boot.ts` — Client-side trustless boot tx builder (browser → contributors, zero custody)
- `src/services/bsv/wallet.ts` — Server wallet with UTXO manager (mutex, spent-blacklist, 0-conf chaining)
- `src/services/bsv/onchain.ts` — OP_RETURN post logging (fire-and-forget; a timeout/failure leaves `tx_id` NULL for the sweep to retry)
- `src/services/bsv/broadcast.ts` — thin test-seam wrapping `Transaction.broadcast()` (used by `boot-confirm` + its integration test so the broadcaster can be mocked)
- `src/services/bsv/covenant-script.ts` — The pay-to-mint covenant's locking script, built with `@bsv/sdk` alone so the sCrypt toolchain never enters the Next build. **⚠ THE CONTRACT CODE IS COPIED FROM CHAIN, NEVER TEMPLATED** — a mint's continuation carries the SAME code as the input it spends (verified byte-for-byte), so only the leading BSV-21 inscription (`amt` changes) and the trailing state (`supply` changes) are rebuilt; the ~24KB middle is transplanted verbatim and cannot drift from the chain. Layout: `<inscription> ‖ <code> ‖ OP_RETURN <bool firstCall><bytes id><int supply><uint32LE len><0x00>`. **⚠ The 5-byte footer locates the state — do NOT scan for the last `OP_RETURN`** (`0x6a` occurs inside 24KB of compiled script by coincidence; the length field is exact and the `OP_RETURN` it lands on is then *checked*). **⚠ `writeBool` is a bare byte, not a push. ⚠ Script numbers need the sign pad** (supply 128 = `0x80 0x00`). **⚠ `continuationState` takes the token id from the OUTPOINT when the input is genesis** — the contract assigns its own id on first spend (`initId`), so copying the empty id forward builds a continuation the covenant refuses, after the author has paid. **⚠ THE PROOF IS IN `contracts/tests/covenantScript.test.ts`, NOT the app's unit tests** — the app's are self-consistent by construction, which is what a wrong byte layout also is. Changing this file without re-running `npm test` in `contracts/` proves nothing. See DECISIONS "The covenant's code is COPIED FROM CHAIN".
- `src/services/bsv/anchor-sweep.ts` — Durable on-chain anchor sweep (`sweepOrphans`). Guarantees the all-posts-on-chain invariant: the queue is just posts with `tx_id IS NULL`, drained by an ambient-traffic single-flight sweep fired fire-and-forget from `createPost` + `GET /api/posts` (no dedicated worker, 0 schema change). 90s min-age avoids racing the inline attempt; in-memory exponential backoff; one broadcast per sweep. Posts re-broadcast on timeout (boosts don't — no payee, no double-pay). See DECISIONS "Durable post-retry: timeout => re-sweep". Unit-tested.

### OP_RETURN Formats (On-Chain Audit Trail)

All on-chain payloads are JSON inside OP_FALSE OP_RETURN outputs:

**Post logging** (`onchain.ts` — every new post):
`{ v, app, type: "post", id, content, author, sig, pubkey, parent, ts }` — sig/pubkey are null for unsigned posts. `id` is the post's own SQLite rowid and `parent` its immediate parent's (null for a thread root, explicitly, so a threading-aware writer's root is distinguishable from a pre-threading record). **`id` and `parent` travel together:** a parent pointer with no record identifier names a row no chain reader can locate, which would leave the thread graph reconstructible only from SQLite. Both are additive optional fields → `v` stays 1 (bumping it would orphan readers of the 2,006 already-anchored genesis records). Both must ALSO be forwarded by `anchor-sweep.ts` — an OP_RETURN is immutable, so a reply swept without its parent is unthreadable forever. Shape pinned by `onchain.test.ts`.

**Boot split** (both boot paths — built by the shared `src/lib/boot-audit.ts` `bootAuditPayload`):
`{ v: 1, app, type: "boot_split", post_id, booter, funded: "server" | "booter", total, recipients?, formula_version?, ts }` — `booter` = address that performed the boot (audit provenance; the server-funded path pays from the server wallet so the booter isn't otherwise on-chain), `funded` = server-subsidised vs booter-paid. `recipients`/`formula_version` are server-path-only. Same shape emitted by `boot-payment.ts` (server-funded) and `client-boot.ts` (client-funded). See FAIRNESS.md.

### Fairness Pipeline

- `src/services/fairness/config.ts` — Tunable parameters (governance surface). Includes `launchTs` (the **launch pool epoch**, env `LAUNCH_TS`, UTC space-format `"YYYY-MM-DD HH:MM:SS"`, fail-closed far-future sentinel default): posts before it are excluded from the pool + boot-price count so the pool starts fresh at launch. Permanent by design — see DECISIONS.md "Launch pool cutoff".
- `src/services/fairness/pricing.ts` — Dynamic boot price (contributors × 156, floor/ceiling, cached). `countActiveContributors(db, launchTs?)` counts only pubkeys with ≥3 posts in the 30-day window AND `created_at >= launchTs` (excludes pre-launch history from the price).
- `src/services/fairness/weights.ts` — Contribution scoring (sqrt × decay × engagement). Posts attribute directly to their signing pubkey/address — no migration chain resolution. `calculateWeights(db, launchTs?)` gates the pool query on `created_at >= launchTs` (pre-launch posts earn no pool share; they still earn the pool-independent 15% creator bonus on boosts). 30s cache is a deploy-constant `launchTs` (not cache-keyed on it).
- `src/services/fairness/split.ts` — No-custody payout split (every sat out in same tx)
- `src/services/fairness/boot-payment.ts` — Multi-output BSV split transaction builder
- `src/services/fairness/boot-orchestrator.ts` — Full boot workflow (validate → price → score → **consume free grant (atomic, pre-broadcast)** → split → broadcast → record). Step 8: `free_boots_used` is consumed in an atomic check-and-increment BEFORE the server wallet broadcasts, so a crash between broadcast and the DB record can't double-pay; no refund on broadcast failure (DECISIONS.md "consume the grant BEFORE paying"). A concurrently-exhausted grant returns `FREE_GRANT_EXHAUSTED` → `bootPost` routes to paid.

### Hooks & Context

- `src/contexts/IdentityContext.tsx` — Shared identity provider (single BSV SDK load). Exposes: `identity`, `isLoading`, `needsUnlock`, `sign()`, `updateIdentity()`, plus the sign-in modal API: `signInOpen`, `openSignIn()`, `closeSignIn()`, `requireIdentity(): boolean`, plus the **read-only (in-app) API**: `isReadOnly` (`isInAppBrowserClient() && !detectStandalone()`, read synchronously on first client render via a lazy `useState` — the `!detectStandalone()` is load-bearing so installed PWAs aren't wrongly locked read-only), `inAppPromptOpen`/`openInAppPrompt()`/`closeInAppPrompt()` (drives `<InAppPromptModal>`, shown on any read-only write attempt — `requireIdentity()` checks `isReadOnly` FIRST, before the identity-truthiness check), and `dismissReadOnly()` (sessionStorage `opencook_inapp_continue` misdetect escape). Also exports `useRequiresIdentity()` ergonomic hook returning `{ identity, requireIdentity }` for callers that only need the guard. Also exposes ref-counted `blockSessionClear()` / `unblockSessionClear()` / `isSessionClearBlocked()` — one shared ref that suppresses BOTH the pagehide-driven `clearSessionCaches()` AND any visibility-related teardown elsewhere (e.g. IdentityBar's `visibilitychange→manageAuthed=false` reset). Used during flows where iOS may fire system sheets (Save Password, Share, Files picker) on standalone PWA — those background blips would otherwise torch an active protect/restore flow. Consumers: ProtectModal, RestoreModal (doImport + performImport). Both have useEffect cleanups as a safety net for mid-flow unmount. IdentityBar reads `isSessionClearBlocked()` to short-circuit its visibilitychange teardown during these flows.
- `src/contexts/BootContext.tsx` — Global boot coordinator: single-flight lock (only one boot in flight at a time across the whole app), 3s UI throttle, status state machine, consolidation-warning dismissal state. Consumed by Bootboard, Feed, PostList, useBoot.
- `src/contexts/InstallContext.tsx` — Global install-pitch state. Exposes the `installSheetMode` state machine (`"hidden" | "sheet" | "bookmark"`), `canPromptInstall` + `promptInstall()` (captures and consumes the `beforeinstallprompt` event for one-tap platforms), `engaged` flag (set on `appinstalled` event or `accepted` outcome — no timer-based suppression), `backedUp` + `protected` derived state, `markBackedUp()` transition, ref-counted `blockInstallPitch()` / `unblockInstallPitch()` / `isInstallPitchBlocked()` (modal-overlap guard — sheet defers fire until protect/passphrase modals close), and `installPitchBlockTick` (React-observable proxy for the ref counter). The 800ms deferred sheet reveal (`SHEET_DELAY_MS`) re-checks `isInstallPitchBlocked()` at FIRE time (not just when scheduled), so a modal opening during the delay still suppresses the sheet — closes the "install pitch pops up during the passphrase save" race (2026-06-26). Cross-tab `storage` listener keeps `backedUp` in sync across tabs.
- `src/hooks/useInstallPlatform.ts` — Detects `installType: "one-tap" | "manual-instructions" | "open-in-safari" | "unsupported"` from UA + capability sniffing. Drives the platform-specific copy in `<InstallPitch>`.
- `src/hooks/useStandaloneMode.ts` — Detects whether the page is already running in PWA standalone mode (used to hide the install pitch entirely if the user is already installed).
- `src/hooks/useIdentity.ts` — React hook for identity management
- `src/hooks/useBoot.ts` — Shared boot logic (free → server, paid → client trustless, consolidation); coordinates with BootContext for global single-flight + 3s throttle
- `src/hooks/useFeedPolling.ts` — Polls /api/posts every 5s (pauses on hidden tab; also `paused` while the feed is in ORIGIN mode so the historical view isn't disturbed by newest-post appends)
- `src/hooks/useScrollTracker.ts` — Scroll position, unread tracking. `trackUnread` option gates the per-article unread IntersectionObserver + badge to LIVE mode only (ORIGIN attaches zero per-article observers). Mount scroll-to-bottom was removed — Feed owns mode-aware landing.
- `src/hooks/useVoiceToText.ts` — Record-and-transcribe mic engine (`getUserMedia` + `MediaRecorder` → POST `/api/transcribe` → Groq Whisper). Returns `{ state: "idle"|"recording"|"transcribing", error, supported, toggle, dismissError }`; the host (`PostForm`) supplies `onTranscript(text)` to insert into the box. Replaced the Web Speech API (unfixable on iOS PWAs — see DECISIONS "Mic: record + Groq Whisper"). iOS-critical: `getUserMedia` in the tap handler, runtime MIME detection (iOS = `audio/mp4`), `recorder.start(1000)`. Pure helpers `pickAudioMimeType`/`extForMime` unit-tested in `useVoiceToText.test.ts`.
- `src/hooks/useBsvPrice.ts` — BSV/USD price (cached 5 min)
- `src/hooks/useCurrencyMode.ts` — Noob Mode ($) / Goat Mode (sats) toggle. Default is ALWAYS dollars (Noob); sats (Goat) is opt-in via the toggle, honored forever once chosen (`hasUserChosen` derived from localStorage presence). No protection-aware auto-flip (removed 2026-06-26 — defaulting a freshly-protected user into sats looked bad; see DECISIONS).
- `src/types/index.ts` — Shared types (Post, BootboardData, Identity, etc.)

## Request Flows

**Post creation — PAID + INSCRIBED (`PAID_POSTING` is ON in production; verified 2026-08-16):**
PostForm → `getPostingMode()` → signPost (ECDSA) → **browser builds, funds and broadcasts a 1Sat
inscription tx** (`client-post.ts`) → createPost server action with `raw_tx` → verify signature +
verify payment (`paid-post.ts`) → insert DB storing the **origin outpoint** (`posts.vout`) → optimistic
UI update → Feed polls for confirmation.

⚠ **Posting SPENDS THE AUTHOR'S OWN SATS — do not tell users posting is free.** ~113 sats/post
(**~$0.000013** at $11.62/BSV, the rate verified live 2026-06-19 and recorded in DECISIONS.md;
this line previously read `~$0.0017`, which was wrong by ~130× and was being quoted to users by
the agent — and, worse, used as the basis for pricing arithmetic. **Sats are the durable figure;
any dollar number here is a snapshot and should be re-derived from the BSV price, not trusted.**):
1 sat inscribed to the author's own address, 12 sats to the platform, ~100 sats fee. A
wallet with **confirmed** funds is a precondition; `/api/balance` reports confirmed-only as
spendable, so freshly-deposited 0-conf money will not post until a block lands. Every money failure
is refused BEFORE broadcast (`insufficient_funds`, `no_utxos`, `payment_required` → see
`POST_FAILURE_TEXT` in `Feed.tsx`), so a refusal never charges the author.

**Legacy (pre-2026-08-16):** posting was free and server-funded — `logPostOnChain` fire-and-forget
`OP_RETURN`, with `anchor-sweep.ts` retrying. The 2,006 genesis records are those unspendable
anchors and stay readable; the sweep still serves them.

**Boot payment (paid):**
BootButton/useBoot → bootPost server action (checks free quota) → requiresPayment response → fetch /api/boot-shares (split calculation) → clientSideBoot (browser builds multi-output BSV tx) → broadcast via ARC → POST /api/boot-confirm with rawTx + booterPubkey + signature (server verifies the booter's ECDSA signature over `boot:<postId>:<txid>` and derives the credited address from the verified pubkey, verifies hash(rawTx)===txid, parses P2PKH outputs locally to check split, re-broadcasts via ARC as safety net, records payouts, emits TX_CONFLICT vs ARC_UNAVAILABLE codes) → Feed polls for bootboard update

**Boot payment (free):**
BootButton/useBoot → bootPost server action → server wallet builds split tx via boot-orchestrator → broadcast → consume free boot grant → return success

## Coding Standards

- Use TypeScript strict mode
- Server components by default, `'use client'` only when needed
- Server actions for data mutations
- Tailwind for styling — no CSS modules
- Dark theme: bg-black, bg-zinc-900, text-white, border-zinc-800
- Mobile-first responsive design

## Identity System

- BSV keypair auto-generated on first visit via `@bsv/sdk` `PrivateKey.fromRandom()`
- Stored as WIF in localStorage under key `bfn_keypair` (plaintext) or `bfn_keypair_enc` (passphrase-encrypted). Legacy key `bfn_identity` is auto-migrated on load.
- Anonymous names: `anon_XXXX` format (4 random alphanumeric chars)
- Posts are cryptographically signed (ECDSA via BSV SDK)
- Users can copy/download their key for backup
- **Recovery files are single-key only.** `pathType` is `"save"` or `"restore-pre"`. Files are stamped with `fileVersion: 1`. Legacy plaintext files and files without a version stamp are rejected by `restore-from-file.ts` as `unsupported_version` — intentional "start clean" policy.
- **The key/address never changes.** Adding a passphrase calls `encryptInPlace`; changing a passphrase calls `changePassphrase`. Both re-encrypt the same underlying WIF in place. There is no key rotation, no sweep, no migration.
- **Manage gate:** the You modal verifies the passphrase once on entry (`manageAuthed` state); session destroyed on modal close or tab blur. Show recovery key + Restore still re-prompt (asymmetric by design — see DECISIONS.md).
- Dynamic imports for `@bsv/sdk` to avoid bundling issues
- Protection path: plaintext localStorage → passphrase encryption (`encryptInPlace`) → passkey wrapping → server HSM
- See DECISIONS.md for the full security upgrade plan

## UX Principles

- **User-facing language matters.** Avoid crypto jargon in normal UI copy. Use friendly equivalents:
  - "save your key" → "keep your name"
  - "fund your address" → "deposit slot"
  - "PIN" → "passphrase" (minimum 8 chars, not a 4-digit PIN)
  - **Exception:** Technical recovery artifacts (backup files, passphrase change flows, the Show recovery key panel) may use precise terms like "key" and "WIF" where clarity for recovery outweighs friendliness. The user is already in a technical context at that point.
- 2-click onboarding: visit site → type idea → click Post. Done.
- No wallet downloads, no seed phrases, no "buy crypto first"

## Security Notes

- Private keys stored in localStorage (acceptable for idea board phase, no real money yet)
- Server-side ECDSA signature verification on all posts
- Rate limiting on all mutation API routes and agent chat (sliding window). Keyed on IP via `x-forwarded-for` for API routes, on pubkey for server actions (createPost, bootPost). Read-only feed polling (`/api/posts`) is unrate-limited by design (hit every 5s by every client).
- boot-confirm hardened: replay protection, on-chain output verification, rate limiting
- CSP headers configured in next.config.ts (Content-Security-Policy, HSTS, Permissions-Policy)
- Node polyfills shimmed via next.config.ts for browser compatibility (empty-module.mjs)
- See SECURITY_AUDIT.md for full audit findings and fix status

## Deployment Notes

- **Rate limiting uses `x-forwarded-for` header** for IP identification. This header is client-supplied — behind a reverse proxy (Railway, Vercel, Cloudflare), the proxy sets it from the real client IP and it's trustworthy. If self-hosting without a proxy, attackers can spoof this header to bypass rate limits. Check your platform's docs for the correct trusted IP header (e.g. Vercel uses `x-real-ip`). All rate limit IP extraction is in the individual API route files (`src/app/api/*/route.ts`) and in `bootPost` (server action, reads `x-forwarded-for` → `x-real-ip` via `next/headers`). **Free-boot diagnostic:** the per-IP free-boot cap (`free-boot-cap.ts`) fails toward PAID on a missing/`unknown` IP — so if a deploy strips BOTH `x-forwarded-for` and `x-real-ip`, ALL free boots silently become paid (safe direction, but if "free boots stopped working / everything is paid," check the proxy is forwarding an IP header).

- **Environment variables.** See `.env.example` for the full list with inline comments. Highlights:
  - `ANTHROPIC_API_KEY` — required for AI agent chat (`/api/agent`)
  - `BSV_SERVER_WIF` — required for on-chain post logging (OP_RETURN). Without it, posts save to DB only with no on-chain fingerprint.
  - `BSV_WALLET_SPEND_DISABLED` — kill-switch (Phase 2 Build C). Set to `true`/`1` to halt ALL server-wallet spending in an emergency (wallet draining / WIF leaked). Free boots transparently route to PAID (no grant consumed — checked pre-consume in `executeBoot`), post-logging is skipped. Paid/client boots are UNAFFECTED. Env var = takes effect on redeploy (a DB-backed instant runtime toggle is a documented fast-follow). Default (unset) = spending enabled. See `wallet.ts` `isServerSpendDisabled()`.
  - `CONTENT_DENYLIST` — pre-publish content filter (Phase 3, illegal-floor only). Patterns (one per line / comma-separated; `/regex/` or case-insensitive substring) that reject a post in `createPost` BEFORE the DB insert + on-chain broadcast — the only point that can stop content reaching the immutable chain. Scope to ILLEGAL content only, not opinions (free-speech ethos). NOT committed (no slur dump in a public repo). Unset = permissive (no filtering) → MUST be set before a public launch. Best-effort + extensible, not comprehensive. See `lib/content-filter.ts` `screenContent()`.
  - `DATABASE_PATH` — defaults to `./local.db`. Railway: set to `/data/local.db` with a mounted volume.
  - `ALLOW_INDEXING` — unset (default) = **noindex** (`app/robots.ts` serves `Disallow: /` + `layout.tsx` emits a noindex meta) for the quiet launch; set `true` to allow search indexing at go-public. No password gate is used — see DECISIONS "Quiet launch: noindex, no password gate".
  - `PORT` — Railway sets this automatically. Vercel ignores it.

- **Genesis DB seed-on-boot.** `seed/genesis.db` (824 KB, 2006 on-chain posts) is committed; `scripts/seed-if-empty.mjs` (run before `npm start` via the Dockerfile CMD) copies it into `DATABASE_PATH` on first boot ONLY when the target is missing/empty — never overwrites a DB with posts, and fails toward preserving a corrupt/locked DB. This is how the launch feed reaches a fresh Railway volume. See DECISIONS "Genesis DB seed-on-boot".

## Development

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run start    # Start production server
npm run test     # Run UNIT tests (vitest, `unit` project — fast, no network)
npm run test:integration  # Run e2e INTEGRATION tests (vitest `integration` project — in-memory SQLite + real crypto, chain mocked; Phase 6)
npm run lint     # Biome linting
npm run format   # Biome formatting
```

## Context Files

Read these to understand the full picture:

- **DIRECTION.md** — Where this project is going and why
- **DECISIONS.md** — Key decisions already made (don't relitigate these)
- **FAIRNESS.md** — Revenue distribution model, fairness formula, gaming analysis, phase progression
- **SECURITY_AUDIT.md** — Full security audit (2026-03-28): 9 criticals fixed, 3 highs fixed, mediums/lows tracked
- **ROADMAP.md** — What's done, what's next, what's planned
- **LAUNCH_PLAN.md** — Active launch-prep scratchpad (temporary; will be `git rm`'d at launch-close per memory `project_launch_plan_lifecycle.md`). 12 confirmed decisions, five work buckets, sequenced build plan
- **DEPLOY.md** — Durable deployment reference. **The app is STATEFUL BY DESIGN** (`better-sqlite3` opens a real file, synchronously, from module scope in `db.ts`), which rules hosts in and out: Railway (current), any Docker host / VPS, anything with a persistent disk — **but NOT Vercel**, where the filesystem is read-only outside `/tmp` and `/tmp` is per-instance, so every DB route 500s at *import* with "unable to open database file" and the `prestart` genesis seed never runs. Making Vercel work means replacing SQLite with a network DB, i.e. `await`-ing every `db.prepare(...)` including `weights.ts`/`pricing.ts`/`boot-orchestrator.ts`/`anchor-sweep.ts` — a large refactor on the money path to use a host offering nothing this app needs. Don't. `docker-compose.yml` is the portable path (bind-mounted `./data:/data` so backups are a `cp`; port bound to `127.0.0.1` because the per-IP rate limits trust `x-forwarded-for`, which is client-supplied and only trustworthy behind a proxy that sets it).
- **LAUNCH_CHECKLIST.md** — Temporary deploy-day do-list (env vars, infra, UptimeRobot, legal, verify) consolidated from every phase. Execute at Phases 8–9; `git rm` at launch-close (same lifecycle as LAUNCH_PLAN.md).
- **QA_CHECKLIST.md** — Temporary Phase 8 manual device-QA script (73 prioritized checks across 7 device profiles, 12 history-grounded fragile-area hotspots, 6 launch-blocker callouts, rebrand visual checks). Owner works through it on real devices; `git rm` at launch-close.
- **FUTURE.md** — Ideas and explorations not yet built (handles, AFP protocol, agents, boot signals)
- **SESSION_LOG.md** — What happened in each working session

## Hard Rules

These are non-negotiable. Do not bend them without explicit approval from the user.

> **Where these came from (noted 2026-08-15).** All eight were written by **upstream OpenCook**
> between 2026-04-03 and 2026-05-05 — months before the fork. None were reviewed when $OpenBooks
> inherited them, and they have been obeyed as house rules ever since. Most hold on their own
> merits and are kept deliberately.
>
> Rule 6 did not hold. It was added in a commit whose own message says it *"removed two instances
> of user's name from CLAUDE.md"* — upstream's author de-personalising his own file. Because it
> says "the user" rather than a name, the referent moved when the project changed hands, and the
> rule began telling assistants to keep the current owner's name off his own copyright notice. It
> is rewritten below. It is also mostly theatre in its original form: upstream's name survives in
> this repo in four places, and what an author actually exposes is the email in their commit
> metadata, which no rule about file contents can reach.
>
> Same treatment DIRECTION.md gives upstream's positions — **inherited is not the same as
> adopted**, and the difference should be visible on the page rather than discovered by an
> assistant enforcing a rule against the owner's interests.

1. **Read DECISIONS.md before proposing changes to identity, security, or fairness.** If a relevant decision exists, acknowledge it before proceeding. Do not relitigate settled decisions — if you want to challenge one, quote the original rationale, state what has changed, and ask first.
2. **No file deletes without confirmation.** Before deleting any file (not in node_modules/.next/build), state what will be deleted and why, and wait for explicit confirmation.
3. **Flag security regressions explicitly.** If a change weakens a control marked FIXED in SECURITY_AUDIT.md (removing rate limiting, relaxing signature verification, etc.), flag it as a security regression and require confirmation.
4. **Every session that modifies code must end with a git commit.** SESSION_LOG entry written, then commit. No leaving modified files uncommitted at session end.
5. **Update DECISIONS.md immediately when a decision is made**, not at session end. Decisions made mid-session affect subsequent work.
6. **No INCIDENTAL personal information in repo files.** Never write names, emails, usernames, addresses or other identifying details into a committed file as a side effect — in comments, fixtures, logs, config, sample content, test data or paths. Repo files are public and effectively permanent, and this is where the leak actually happens.
   - **Deliberate attribution is different, and is allowed wherever it is load-bearing:** copyright notices and `LICENSE`, `AUTHORS`, security and DMCA contacts, and the operator/jurisdiction fields in `legal/*.md`. These are published *on purpose* — anonymous copyright is weaker copyright, and a DMCA agent nobody can name does not function. This board's entire proposition is *own what you post*; a build rule that strips authorship out of the repository argues against the product inside it.
   - **Never invent one.** Add a name or address only where the owner has stated it. If it has not been stated, ask.
   - ⚠ **Do NOT "fix" a name out of `LICENSE` or a legal document on the strength of this rule.** That is exactly what the previous wording caused (see the note above). The copyright line in `LICENSE` is deliberate and stays.
   - This rule governs FILE CONTENTS only. Commit author metadata is a separate exposure it cannot reach.
7. **Transaction handlers must use `requireIdentity()`.** Any handler needing a signed BSV identity (post, boot, tip, any future transaction) begins with `if (!requireIdentity() || !identity) return;` per the "Universal pattern: transaction action requires sign-in" section above. Do not directly call `signPost`, `clientSideBoot`, or any other wif-using service from a UI handler without this gate — it would silently fail when the user is locked instead of opening the SignInModal.
8. **Always ask before pushing to origin.** Commit locally without permission (per Hard Rule #4 — sessions must end with a git commit), but `git push` requires explicit user approval each time. Don't chain `git commit && git push` in one command. Don't assume "if I just committed, the user wants me to push" — they may want to test on another device, review the diff, or stage multiple commits before publishing. Push is a public action that affects the GitHub repo, deploy hooks, and any subscribers; commit is local. Treat them as different in tone and confirmation.

## Context Management

When you estimate you are above 70% of context capacity during a working session:

1. **At 70%**: Write a checkpoint — update SESSION_LOG.md with current state, what's done, what's next, what was ruled out. Continue working.
2. **At 80%**: Finish the current atomic unit of work (don't stop mid-edit). Commit all changes. Update ROADMAP.md and DECISIONS.md if anything changed.
3. **At 85%**: Stop new work. Tell the user: "Context is getting full — I've saved state. Start a new session to continue."

**SESSION_LOG entries must include:**
- What category of work was done (feature, security, refactor, etc.)
- Specific files changed and why
- What was explicitly ruled out or deferred
- What is still broken or incomplete
- The next step if the session ended mid-task

**Restart read order for new sessions:** CLAUDE.md → ROADMAP.md → DECISIONS.md → SESSION_LOG.md (last entry)

## AI Contribution Protocol

When you finish significant work on this project:

1. Update ROADMAP.md if you completed or started a task
2. Update DECISIONS.md if you made a non-obvious technical choice
3. Update FAIRNESS.md if you changed the revenue model, fairness parameters, or contribution scoring
4. Update DIRECTION.md only if the project direction changed
5. Update this file (CLAUDE.md) if you added new key files or changed architecture
6. Add a session summary to SESSION_LOG.md (date, 3-5 bullet points of what was done)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
