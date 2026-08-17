# Launch Checklist

> **Temporary file** — the single "what the operator must DO to go live" list, gathered
> from every phase. It is NOT a record (the *decisions* live permanently in DECISIONS.md /
> ROADMAP.md / `.env.example`); it's a do-list for deploy day. **`git rm` this at
> launch-close** (same lifecycle as LAUNCH_PLAN.md). Work it top to bottom at Phase 9.
>
> **Status, reconciled 2026-08-17.** Stages 1–3 HAVE HAPPENED — the site is live at
> `openbooks.space` on Railway with a funded server wallet (`/api/health` green, 663,647 sats,
> 0 pending anchors) and the 2,006-post genesis feed seeded. **Stage 4 (go public) is the
> remaining one**, and `robots.txt` still serves `Disallow: /`, so the quiet launch is holding.
>
> ⚠ This file was written before launch and still described stages 1–3 as pending, on a domain
> (`opencook.fun`) that was never used. Domain references corrected throughout. The **§4 legal**
> and **§1 `CONTENT_DENYLIST`** items below are the real remaining gates, not the Railway setup.

## 0. Deployment approach — Railway, SINGLE-DOMAIN quiet launch

> **Platform = Railway** (the repo is already wired: `railway.toml` + `Dockerfile`, `/data` volume).
> **NOT a self-managed VPS** — see DECISIONS "Deploy on Railway, NOT a self-managed VPS". Decider:
> a VPS exposes the server-wallet key (`BSV_SERVER_WIF`) to anyone with root; Railway keeps it in
> your own env vars.
>
> **Sequence: (1) throwaway shakeout → (2) code prep → (3) real gated quiet launch on `openbooks.space` → (4) go public (same URL).**
>
> **Why single-domain, NOT a staged `alpha.` subdomain** (two independent agent reviews, 2026-08-09):
> localStorage identities are **per-origin**, so an alpha→apex flip would wipe every tester's account —
> and could silently lose an *earner* real sats (they never trip the backup gate); on-chain posts are
> **permanent regardless of domain**, so a subdomain is NOT a sandbox; rollback is cleaner (no DNS
> flip); there is **no service worker**, so no stale-cache risk on the real origin. Real test-safety
> comes from deploying with **no server key first**, not from a subdomain. See SESSION_LOG 2026-08-09.

### Stage 1 — Throwaway shakeout ✅ DONE (kept for the record; nothing here is outstanding)
Goal: prove the deploy MECHANICS with no real domain, no funded key, a junk DB. Throw it away after.
- [x] Create a Railway account + connect the GitHub repo to a NEW project (uses `railway.toml`/`Dockerfile`).
- [x] Add a **Volume** mounted at `/data`; set `DATABASE_PATH=/data/local.db`.
- [ ] **Leave `BSV_SERVER_WIF` UNSET** — CRITICAL: this (not the domain) is what keeps test posts OFF mainnet. Skip `CONTENT_DENYLIST`, legal, gate — it's a throwaway.
- [x] Deploy. Watch the build log: **confirm `better-sqlite3` compiled**. If `nixpacks` picks the wrong Node and the native compile fails, switch the builder to the **Dockerfile** (Railway → service → Settings → Build).
- [x] Confirm: app boots, `GET /api/health` returns JSON, the feed renders (empty DB is fine), a test post saves (it'll have `tx_id` NULL — correct: no key = no broadcast).
- [ ] Confirm `x-forwarded-for` carries a real client IP (same proxy layer as prod — testable here; every per-IP cap depends on it).
- [x] Delete the throwaway project (or keep as a staging toy). Nothing here touched the chain.

### Stage 2 — Code prep for the real deploy (in the repo, before going live)
- [x] **Env-driven noindex** (DONE 2026-08-10) — search-indexing is OFF by default; `src/app/robots.ts` + the `robots` meta in `layout.tsx` both gate on `ALLOW_INDEXING`. Keeps a rough `openbooks.space` out of Google during the quiet phase. Reverse at **Stage 4** by setting `ALLOW_INDEXING=true`. **No Basic-Auth password gate** — deliberately skipped for a small trusted quiet launch (the browser popup adds real friction; the wallet is already bounded by the per-IP/daily-spend caps, and `CONTENT_DENYLIST` guards the permanent chain). See DECISIONS "Quiet launch: noindex, no password gate".
- [x] **Fee-rate bump** (DONE 2026-08-10) — all three `SatoshisPerKilobyte(100)` → `110` (`wallet.ts` server paths + `client-boot.ts` ×2), fixing the 1-sat ARC error-465 rejection seen during genesis seeding. BSV-agent-verified; build + 161 unit tests green.
- [x] **Dedicated server key** — generate a FRESH BSV key (never a personal wallet; see §1 `BSV_SERVER_WIF`). Owner runs the key op in their own terminal; the WIF never goes in a committed file.
- [x] Commit + push. *(noindex + fee bump already committed.)*

### Stage 3 — Real gated quiet launch on `openbooks.space` ✅ DONE — the site is live and noindexed
- [x] Connect the repo to the real Railway project; add the **Volume** at `/data`; `DATABASE_PATH=/data/local.db`.
- [x] **Genesis DB** — ships automatically via the committed `seed/genesis.db` + copy-on-first-boot (`scripts/seed-if-empty.mjs`); no manual upload. Just confirm the feed shows ~2,006 posts after the deploy (see §2).
- [x] Set ALL env vars from §1 — the **dedicated** `BSV_SERVER_WIF`, `LAUNCH_TS` (UTC!), `CONTENT_DENYLIST`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `HEALTH_TOKEN`, `DATABASE_PATH`. **Leave `ALLOW_INDEXING` UNSET** (noindex stays on during the quiet phase). Leave `BSV_WALLET_SPEND_DISABLED` unset; don't set `PORT`.
- [x] **Fund the (dedicated) server wallet** (§2).
- [x] **Point `openbooks.space` (+ `www`)** — DONE 2026-08-12. At the registrar: `www` CNAME → the Railway-provided target + Railway's verify TXT record → Railway verified the domain + auto-provisioned Let's Encrypt SSL. Bare `openbooks.space` → registrar Domain Forwarding (301, forward-only, NO masking) → `https://www.openbooks.space` (works http + https). Both serving the genesis feed. *(Exact record values live in the registrar/Railway dashboards, not here.)*
- [x] Confirm **noindex is active**: `GET https://openbooks.space/robots.txt` shows `Disallow: /` (indexing blocked until Stage 4).
- [x] **UptimeRobot** — DONE 2026-08-12. Monitoring `/api/health` on the live domain (5-min HTTP), alerts to a dedicated project ops email (verified). No `HEALTH_TOKEN` yet → `/api/health` is public (exposes the wallet balance figure, not the address; optional hardening: set `HEALTH_TOKEN` + append `?token=` before public).
- [ ] **Legal minimum** *(practical risk framing, NOT legal advice)*: `CONTENT_DENYLIST` **DEFERRED to go-public by decision 2026-08-11** (quiet launch = small trusted group, which is the mitigation — see §1); fill the cheap `[TODO]`s — **contact email + effective date** (⚠️ operator's real legal name goes in the DEPLOYED copy ONLY — never the repo, Hard Rule #6); confirm the **PermanenceGate** fires before the first post.
- [x] Invite the trusted group to the real URL (unadvertised — no password gate). Their accounts persist here forever — no migration.

### ⚠ Added 2026-08-17 — gates that did not exist when this list was written

The token economy shipped after this file was drafted, and it moves one item from "later" to
"before you advertise":

- [ ] **A lawyer sees the MARKET, not just the posts.** TOKENS.md's own standing note is *"get a
      real opinion before the MARKET ships — not before the tokens exist, before they become
      tradable for money."* Holders can now list units and buyers can fill those listings, so that
      condition is met. This folds into the ~1hr legal review already listed in §4 rather than
      being a separate engagement, but it changes what the review has to cover.
- [ ] **Decide whether resale takes a platform cut** before volume exists. Currently zero,
      deliberately — see DECISIONS. Adding one later is a price change on a live market; setting it
      now is a decision made once.
- [ ] **The covenant is NOT deployed.** `contracts/` compiles and passes its refusal tests, but no
      contract exists on any chain, so `$Ticker` units remain a database ledger and resale remains
      platform-mediated. Nothing about the live site depends on this — but any public claim that
      tokens are "on-chain tokens" would be false until it lands. See ROADMAP.

### Stage 4 — Go public (same URL — a config change, not a rebuild) ⬅ **THE REMAINING STAGE**
- [ ] *(Optional — only if you want a pristine feed)* Re-upload the off-repo pristine genesis master over `/data/local.db`. Stage-3 trusted-group test posts are permanent on-chain and otherwise stay visible in the feed (they're already excluded from earnings by `LAUNCH_TS`). Easy to forget — make it a deliberate step.
- [ ] **Set `ALLOW_INDEXING=true`** — reverses the quiet-launch noindex so Google can crawl/index the site. ⚠️ Don't forget this, or the public site stays invisible to search. (`GET /robots.txt` should flip to `Allow: /` / `Disallow: /api/`.)
- [ ] Complete §4 legal (lawyer pass on the 3 `[LAWYER]` hard clauses + fill the binding `[TODO]`s + register the DMCA agent) and §5 verification (smoke test + re-confirm `x-forwarded-for`).
- [ ] Advertise. Done — no domain switch, no data or identity discontinuity.

### Railway gotchas (know these before the first deploy)
- **Build (CONFIRMED on the 2026-08-10 shakeout):** Railway uses the **`Dockerfile`** (which installs `python3 make g++` to compile `better-sqlite3`), NOT the `nixpacks` line in `railway.toml` — the Dockerfile wins. `better-sqlite3` compiles cleanly this way. The Docker `VOLUME` instruction was **removed** (Railway rejects it — "use Railway Volumes"); persistent storage is the dashboard Volume, not a Docker VOLUME.
- **Volume must be attached in the DASHBOARD + then redeploy.** The `[deploy.volumes]` line in `railway.toml` alone does NOT mount it (confirmed — the shakeout 500'd with "directory does not exist" until the Volume was attached at `/data` via the dashboard and the service was redeployed).
- **Keep `healthcheckPath = "/"` — do NOT point it at `/api/health`.** `/api/health` intentionally returns **503** on operational issues (low balance, no wallet), which would fail Railway's deploy healthcheck and restart-loop. `/` returns 200 whenever the app + DB are up. (`/api/health` is for the external UptimeRobot monitor, which alerts on non-200 — that's the point there.)
- **DB backups are thin on Railway** — set up a simple periodic copy of `/data/local.db` off-box (it holds posts + earnings).
- **`x-forwarded-for`** — verify on the first real deploy that requests carry a genuine client IP (the cloudflared-tunnel testing masked this); every per-IP cap depends on it.
- **In-memory caps** (daily spend, rate-limit windows) reset on every redeploy — documented + acceptable; just don't be surprised by a burst of redeploys near launch.
- **In-app handling is client-side now** — `page.tsx` is static/cached and does NO server-side UA detection (Telegram-iOS is caught client-side via `window.TelegramWebviewProxy`). A proxy stripping `user-agent` no longer affects the in-app experience. The funds floor is the **value-gate** (`FundAddress` hides the deposit address until the account is backed up) — detection-independent, so even a total detection miss can't strand funds. Worth a real-device sanity check post-deploy: open a shared link in Telegram-iOS → confirm the feed is read-only (any tap → "open in your browser") and that the deposit screen demands "save your account first."

## 1. Environment variables (Railway → service → Variables)

- [ ] `BSV_SERVER_WIF` — server wallet private key (WIF). Required for on-chain post logging + server-funded free boosts. Without it, posts save to DB only (no on-chain fingerprint). **Use a DEDICATED key** (generate a fresh one, e.g. `node scripts/generate-wallet.mjs`) — **never a personal wallet**: this address publicly funds + collects for the entire platform on-chain, permanently, so a personal key links your identity/funds to OpenCook forever.
- [ ] `ANTHROPIC_API_KEY` — required for the "Ask AI" agent chat.
- [ ] `GROQ_API_KEY` — *(optional but recommended)* powers the compose-box voice-to-text mic (`/api/transcribe` → Groq Whisper). Free key, no card, from https://console.groq.com/keys (free tier 2,000 transcriptions/day). Unset = the mic shows "voice input offline" on tap; everything else works. *(optional)* `TRANSCRIBE_DAILY_LIMIT` caps daily transcription calls (default 2000).
- [ ] `CONTENT_DENYLIST` — illegal-floor pre-publish filter (Phase 3). **⚠️ DEFERRED-BY-DECISION (2026-08-11): the quiet launch went live with this EMPTY** (small TRUSTED group = the mitigation; leaving it empty avoids over-blocking legal speech before it's tuned — a text denylist matches words, not intent). **HARD pre-public blocker** — before going public, populate the illegal floor (primarily **CSAM**) from a **lawyer / trust-and-safety-sourced** keyword list (part of the ~1 hr CSAM/broadcaster legal review), NOT an improvised list. Unset = permissive/no filtering. Matching = case-insensitive substring, or `/regex/` in slashes; comma- or newline-separated; `#` comments allowed. Scope to ILLEGAL content only (NOT opinions/profanity — free-speech ethos). NOT committed.
- [ ] `LAUNCH_TS` — **BLOCKING: set to the TRUE launch instant, in UTC, format `YYYY-MM-DD HH:MM:SS`.** It's the pool epoch: posts before it (the genesis seed + all pre-launch/test posts) are excluded from the 80% pool + the boot-price count so the pool starts fresh; they still earn the 15% creator bonus on boosts. **Unset = a far-future sentinel → the pool never opens (empty pool, floor price).** Fail-closed is deliberate (never leaks pre-launch posts into payouts), but that means forgetting this = nobody earns pool share. Must be UTC (a local-time value silently shifts the epoch).
- [ ] `HEALTH_TOKEN` — bearer token gating `GET /api/health` (Phase 5). Set a long random string; you'll put it in the UptimeRobot URL.
- [ ] `ALLOW_INDEXING` — controls search-engine indexing. **Leave UNSET during the quiet launch** (default = noindex: `app/robots.ts` serves `Disallow: /` and `layout.tsx` emits a `noindex` meta). **Set to `true` at Stage 4** to let Google index the public site. No password gate is used (see DECISIONS "Quiet launch: noindex, no password gate").
- [ ] `DATABASE_PATH=/data/local.db` — points SQLite at the mounted volume (see §2).
- [ ] *(optional)* `SERVER_DAILY_SPEND_SATS` — daily server-wallet spend ceiling (default ~1,721,170 = ~$0.20/day). Tune or leave default.
- [ ] *(optional)* `ONCHAIN_POST_IP_LIMIT` — per-IP daily on-chain post cap (default 200). Tune or leave default.
- [ ] Leave `BSV_WALLET_SPEND_DISABLED` **unset** — that is the emergency kill-switch (set to `true`/`1` only to halt all server spending in a drain/leak emergency; takes effect on redeploy).
- [ ] `PORT` — Railway sets this automatically; do not override.

> Full descriptions with inline comments are in `.env.example`.

## 2. Infrastructure

- [ ] **Fund the server wallet** — send some sats to the `BSV_SERVER_WIF` address (covers free boosts + post-logging fees; ~66 sats/post, ~1,000+ sats/free boost). Watch the low-balance alert (§3) and top up.
- [ ] **Mounted volume** for the SQLite DB at `/data` (so the DB survives redeploys), matching `DATABASE_PATH`.
- [x] **Genesis DB ships AUTOMATICALLY (built 2026-08-11)** — `seed/genesis.db` (824 KB, 2,006 posts = 98 kept + 1,908 genesis, all on-chain) is **committed to the repo**, and `scripts/seed-if-empty.mjs` (run before `npm start` via the Dockerfile CMD) copies it into `/data/local.db` on first boot. It seeds ONLY when the target is missing/empty, so it NEVER overwrites a live DB — and fails toward PRESERVING a corrupt/locked DB rather than overwriting it. No manual upload. See DECISIONS "Genesis DB seed-on-boot". Just confirm the feed shows the genesis posts after the first deploy (it replaces the empty shakeout DB automatically).
- [ ] **Trusted proxy must set `x-forwarded-for` / `x-real-ip`** — Railway does this by default. **Every per-IP control depends on it** (the 200/day post cap, free-boot cap, all route rate limits). If a deploy ever strips both headers, header-less requests share one bucket → free boots silently all become paid and posts can hit a shared daily cap. Verify after first deploy by checking a couple of requests carry a real client IP.

## 3. External services

- [ ] **UptimeRobot monitor** on `GET /api/health?token=<HEALTH_TOKEN>` (Phase 5):
  - HTTP(s) monitor, 5-min interval, your email as the alert contact.
  - Alerts on any non-200 — the endpoint returns **503 when a critical condition trips** (wallet low, posts not anchoring, kill-switch on, daily spend ceiling hit) and on full server-down.
  - *(optional)* add a keyword check: alert if the body does NOT contain `"ok":true`.
  - Bookmark the same URL — it's your at-a-glance health page.

## 4. Legal / owner (Phase 3 — NOT build blockers, but do before public launch)

- [ ] **~1 hour with a lawyer** on the 3 hard risks flagged in the legal drafts: GDPR-erasure-vs-immutable-chain, CSAM/operator-as-broadcaster, money-transmitter exposure (the `[LAWYER]`-marked clauses).
- [ ] **Register a DMCA agent** (the drafts deliberately leave the process to a lawyer decision).
- [ ] **Fill the `[TODO]` placeholders** in `legal/terms-of-service.md`, `legal/privacy-policy.md`, `legal/permanence-acknowledgement.md` — operator legal name, jurisdiction, contact email, effective dates.

## 5. Pre-launch verification

- [ ] **Cross-device QA** (Phase 8) — post / boost / install / deposit on iPhone + Android + desktop.
- [ ] **Production smoke test** — `npm run build` green; post a test idea and confirm it lands on-chain (check the tx); do one free boost + one paid boost; open `/api/health` and confirm `"ok": true`.
- [ ] Confirm `CONTENT_DENYLIST` is actually set (the one item that silently fails open if forgotten).
- [ ] Confirm `LAUNCH_TS` is set to the true launch instant (UTC). Sanity-check: a post made just AFTER that instant enters the pool / boot-price count, and the seeded pre-launch posts do NOT (they still earn the 15% creator bonus on boosts).

## 6. Pre-launch gap-audit findings (2026-06-30 — 4-agent sweep: deploy / legal / security / code)

> Build + 156 unit + 38 integration tests + 0 lint all green; **no broken code**. These are config / content / legal / deploy-correctness gaps the earlier sections didn't capture. ALPHA = before sharing the alpha link; PUBLIC = before opening to everyone / real funds.

### New ALPHA items (beyond §1–§5)
- [ ] **Switch `railway.toml` builder to `dockerfile`** — the Dockerfile pins Node 20 + installs `python3 make g++` for `better-sqlite3`'s native compile; nixpacks may pick Node 22 and fail. Then watch the first build succeed.
- [ ] **Change `railway.toml` `healthcheckPath` from `/` → `/api/health`** — the root page hits the DB on boot; if the volume isn't mounted yet, `/` 500s into a restart loop.
- [ ] **Confirm the Railway Volume is actually attached at `/data` in the dashboard** (the `[deploy.volumes]` TOML alone may not wire it on current Railway).
- [ ] **Raise `serverLowBalanceAlertSats`** from ~10k → ~50k sats before funding (10k ≈ ~7 free boosts of runway).
- [ ] After funding, **watch `/api/health` for `wallet.balanceSats > 0` + `low:false`**.
- [ ] **Verify the Anthropic model id** (`claude-haiku-4-5-…`) is valid for the key + set a monthly cap in the Anthropic console; set a Groq cap too if on a paid key.
- [ ] *Alpha gate* — build the ~15-line `middleware.ts` Basic-Auth (must EXEMPT `/api/health`) **or** simply don't advertise the URL.

### New PUBLIC items (before opening to everyone / real funds)
- [ ] **Confirm Railway runs exactly ONE instance** (or move the spend-ceiling + rate-limiter to Redis) — the caps are in-memory per-instance, so N instances = N× the $0.20/day ceiling + split rate-limit buckets.
- [ ] **Build an instant runtime kill-switch toggle** (DB/Redis-backed) — `BSV_WALLET_SPEND_DISABLED` needs a redeploy to take effect = minutes of exposure during a live wallet drain.
- [ ] **OG image (1200×630) + `metadataBase` + `og:url`** in `layout.tsx` — shared links are blank cards otherwise (matters for a share-driven launch).
- [ ] **Error monitoring** (Sentry, or a Railway → Logtail/BetterStack log drain) — `console.error` into 7-day Railway logs is the only signal today.
- [ ] **Off-Railway DB backup — set up early (before real users/earnings accrue).** *(Parked 2026-08-11 — not launch-day-blocking, but do it soon after.)* The Railway volume `/data/local.db` is the only *convenient* copy of live data (new posts + earnings + bootboard). Genesis is safe regardless (repo `seed/genesis.db` + on-chain + volume), and **every post's content is permanently on-chain** (ultimate backstop) — but rebuilding the working DB from a chain scan is a recovery *project*, not a click. So schedule a simple periodic copy of `/data/local.db` → R2 / S3 / Backblaze (Railway cron or a GitHub Action). ~30 min. NOTE: the genesis seed is copy-if-empty, so restoring a backup = drop the file on the volume and redeploy (the seed won't overwrite a DB that has posts).
- [ ] **Broadcast-proxy / ARC failover** (`/api/broadcast`, Phase 6.5) — a single ARC provider is a SPOF that halts ALL boosts (free + paid) during an outage.
- [ ] **`anon_XXXX` handle collisions** (FUTURE.md "before launch" item — ~1% collision at 184 users).
- [x] **`robots.txt`** — DONE: env-driven `src/app/robots.ts` (noindex `Disallow: /` until `ALLOW_INDEXING=true`, then `Allow: /` + `Disallow: /api/`).
- [ ] **Legal (public):** the ~1hr lawyer pass on the 3 hard clauses (**CSAM/operator-as-broadcaster is #1** — your server signs every post, so it doesn't de-risk like the others); fill ALL binding `[TODO]`s; remove the "Draft — not final" banner + flip docs in-force; age-gate decision; lawyer look at the "earnings/real-money" UI framing; register the DMCA agent.

### NICE-TO-HAVE (debt)
- [ ] Branded `not-found.tsx` (404 is Next's default page now).
- [ ] Remove the 7 left-in `console.log`s in `src/services/bsv/client-boot.ts`.
- [ ] `wallet.ts` invalid-WIF handler: log `e.message` only (avoid echoing key material on misconfig).
- [ ] Reconcile SECURITY_AUDIT.md (H3 effectively resolved). Tracked debt: PBKDF2 100k→600k, CSP nonce, authenticated financial reads.

---

*When every box is ticked and you're live: `git rm LAUNCH_CHECKLIST.md` and commit — the launch is closed.*
