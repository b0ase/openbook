# Roadmap

> Where this is, what's next, what's parked. **AI agents: update this file when you finish or start
> something.** Rewritten 2026-08-14 — the previous version predated the token model entirely and
> would have given a fresh reader a materially wrong picture.
>
> **Read order for a new session:** CLAUDE.md → this file → DECISIONS.md → TOKENS.md →
> SESSION_LOG.md (last entry).

## Where this is now

**$OpenBooks is LIVE at `openbooks.space`** (Railway, valid certs, `www` too), serving a 2,006-post
genesis feed that auto-seeds a fresh volume. 393 unit + 170 integration tests; lint, tsc and a
zero-warning production build all green.

**The board works.** Posting, signing, on-chain anchoring, boosts, the boost board, earnings,
threads, `$Ticker` claiming, `$Nym` names, media uploads, search, the `/tickers` index, and a wallet
panel showing what you hold.

**Two things are true that a reader needs to know up front:**

1. **We ANCHOR, we do not INSCRIBE.** Every post gets an `OP_FALSE OP_RETURN` record — a permanent,
   signed, timestamped *audit trail*. That output is provably unspendable, so **no post is yet an
   on-chain object anyone can own or transfer.** A post is a token in the database and the UI, with
   an independent chain record beside it.
2. **Nothing costs money yet.** Posting, claiming a name and boosting are free (server-funded).
   Every economic decision in TOKENS.md is gated on that changing.

## The next milestone: paid posting + inscription

**These ship together or not at all.** You cannot afford to inscribe for free (the operator funds
every anchor today, under a daily spend ceiling), and you cannot sell what was never inscribed.

Concretely: a post's data moves onto a **1-satoshi spendable output** at the author's address, so
ownership becomes "whoever can spend that satoshi", and the token's identity becomes its **origin
outpoint `<txid>_<vout>`** — not the SQLite id, not a content hash. See DECISIONS.md.

**Server side is BUILT and flag-gated** (`PAID_POSTING`, default off):
`inscription.ts` (1-sat ordinal envelope), `post-economics.ts` (flat cost-plus),
`client-post.ts` (browser builds + funds + broadcasts), `paid-post.ts` (server verifies), and
`createPost` storing the outpoint (`posts.vout`) instead of paying to anchor.

- [ ] ⚠ **Broadcast ONE inscription and confirm a public indexer shows it.** The envelope follows
      the 1Sat convention and is unit-tested for shape, but shape is not recognition. **Nothing may
      be charged for until this passes.** It costs a few pence and only the owner can authorise it.
- [ ] **Wire the compose box** — price quote, insufficient-funds → deposit, the paid submit path.
      `clientSidePost` has no caller yet.

**Waiting behind this gate, in order:**

- [ ] **Tagging.** The `(from_post, ticker, target)` edge table is BUILT (`ticker_mentions`,
      `target_type ∈ {none, post, ticker}`). **Nothing writes a targeted row yet — deliberately.**
      Free tags would put `$COOL` on everything within a day and the units could never be recalled.
- [ ] **The payment split.** Top 100 holders, with an amount floor (~10 sats — a UTXO below its own
      spending cost is worth less than nothing). `ticker_mentions` already holds everything needed;
      the split is two queries.
- [ ] **Citation/quote-minting.** The quoter holds the new unit.
- [ ] **The market.** OrdLock listings, no custody — every satoshi leaves in the transaction it
      arrived in.
- [ ] **Does ordinary posting become paid, or only minting a ticker?** Carried question, still open.

## Blocked on the owner (I cannot do these)

`LAUNCH_CHECKLIST.md` has **61 unchecked items**; these are the ones that actually gate going public:

- [ ] **`CONTENT_DENYLIST` is unset** → the pre-publish filter is permissive. It is the ONLY point
      that can stop content reaching an immutable chain.
- [ ] **~1hr with a lawyer** on three risks: GDPR erasure vs an immutable chain, CSAM /
      operator-as-broadcaster, money-transmitter characterisation.
- [ ] **DMCA agent registered**, `[TODO]` placeholders filled in `legal/*.md`.
- [ ] **`ALLOW_INDEXING=true`** at go-public (currently noindex, deliberately).
- [ ] **Off-Railway DB backup**, UptimeRobot on `/api/health`.

## Undecided — token model

Full reasoning in TOKENS.md; these are the live questions, not a summary of settled ones.

- [ ] **Separator:** `/` for lineage vs `#` for serial. Hardens into consensus once written on-chain.
- [ ] **Is a bought post unit #1, or the ISSUER POSITION?** (Leaning: genesis IS the issuer position
      and is not for sale.)
- [ ] **Does a sold post carry its `$Ticker` name with it?** Schema says yes today.
- [ ] **Who benefits from the split, and to what end** — settled far enough to build (top 100), but
      the purpose question behind it is open, and it decides whether a "receipt" that pays income
      stays a receipt.

## Backlog — engineering

**Resilience (the real one first):**

- [ ] **Build D — `/api/broadcast` proxy + provider failover (GorillaPool→TAAL).** A single ARC
      provider is a SPOF: an outage today means *no boots at all*, server-funded or client-paid
      (precedent: outages 2026-04-08, 04-14). ⚠ When built it must **submit-same-bytes-or-report
      only** — never re-fee, re-serialize or rebuild a tx, any of which changes the txid and
      double-pays — and must preserve ARC's structured error codes (257/258/indeterminate) that the
      client's "rebuild only on TX_CONFLICT" rule depends on. ~4–6h.
- [ ] **Split mutexes: posts vs boots.** Posts (1-in 1-out, ~20ms) share a mutex with boot splits
      (10–15 outputs, longer ARC round-trip), so a boot queue starves posts under burst. `wallet.ts`.
      ~1h.
- [ ] **Backpressure on `logPostOnChain`** when mutex queue depth exceeds N. ~30min.
- [ ] **WoC retry/backoff in double-spend recovery.** `wallet.ts` swallows errors as
      `/* best effort */`, leaving competing UTXOs un-blacklisted. ~1h.
- [ ] **DB-backed instant kill-switch** (env-var today, needs a redeploy to trip).
- [ ] **Multi-instance safety.** Wallet mutex, UTXO reservation and the spent-blacklist are all
      in-process memory. Two instances on one `BSV_SERVER_WIF` will double-spend. **Hard gate before
      horizontal scale**, not a launch blocker.

**Product:**

- [ ] **Thread URLs.** Opening a thread doesn't change the URL, so it is not shareable or
      back-button-able. Affects the feed and the wallet equally — fix both paths at once.
- [ ] **Daily posting limits (5 free/day) + QR funding at the limit.** Spam defence today is a
      10/min per-pubkey and 200/day per-IP rate limit only.
- [ ] **Near-instant payment UI (SSE + optimistic updates).** Recipient sees earnings in ~300ms
      instead of 15–60s polling. Single-instance constraint applies (in-process EventEmitter). Do
      after Build D so ARC error codes are stable. ~3–4h.
- [ ] **Pending-payment badge** ("$0.12 · 1 pending"). Natural fit once SSE lands. ~30–60min.
- [ ] **Notification system** (bell — "someone featured your post", daily earnings summary).
- [ ] **Agent chat: DB query tools** (live oracle — real post counts, contributor stats, prices).
- [ ] **Rename `boot` → `boost`** in schema/API/identifiers. UI copy already says Boost.
- [ ] **Thread-aggregated boot counts** — touches `weights.ts` + bootboard semantics.
- [ ] `/tickers` serves an empty build-time prerender to the first visitor after each deploy (ISR
      fills it within ~30s). Cosmetic, but it reads as data loss.

**Tech debt:**

- [ ] **Refactor `clientSideBoot` + `consolidateUtxos`** — duplication across broadcast-result
      classification. Lower priority; revisit if the file grows.
- [ ] **Client-side IndexedDB source-tx cache** — the server-side cache already solves the real
      problem. Low priority.
- [ ] **Identity security ladder (all future):** passkey/WebAuthn PRF wrapping, Firefox passphrase
      fallback, auto-lock on inactivity, device sync by QR.

## Do not relitigate

These were decided or tried and rejected. Re-proposing them wastes a session.

- **Identity-modal Stage 4** (3-question intent-led layout) — built, rejected on live review,
  reverted. The flat section list is settled.
- **Path B identity-modal refactor** — adversarial review found 4 real bugs including a tab-blur
  fund-loss window. Deferred with reasons.
- **In-card AI button** — red-teamed twice; key-exfiltration and bad-advice-on-irreversible-actions
  outweigh the benefit.
- **Currency toggle labels** ("🐐 Goat / 💵 Noob") and the repeated "keep it somewhere safe" mantra
  stay as they are — both designer-validated.
- **Vercel** cannot host this app (synchronous `better-sqlite3` from module scope). See DEPLOY.md.
- **Key rotation** — removed 2026-06-14 in favour of encrypt-in-place. The key/address never changes.

## Done

Compressed. Per-session detail is in SESSION_LOG.md; the reasoning is in DECISIONS.md.

| | |
|---|---|
| **Foundation** | Next.js 16 + React 19 + Tailwind v4, SQLite (WAL, auto-migration), BSV identity, signed posts |
| **UI** | Telegram-style feed, boost board, genesis/manifesto, agent chat, voice-to-text (Groq Whisper), LIVE/ORIGIN feed modes |
| **Security** | Server-side ECDSA verification, rate limiting, CSP/HSTS, AES-256-GCM passphrase encryption (PBKDF2 600k), version-gated restore, boot-confirm hardening. Two full audits. |
| **On-chain** | Server wallet + UTXO manager (mutex, 0-conf chaining, spent-blacklist), OP_RETURN anchoring, durable anchor sweep (no orphans) |
| **Fairness** | Contribution weights (sqrt × decay × engagement), no-custody split, dynamic boot price, launch-pool cutoff |
| **Abuse/cost** | Per-IP + per-identity caps, daily server-spend ceiling, kill-switch, illegal-floor content filter, permanence gate, `/terms` + `/privacy` |
| **Observability** | `/api/health` (200 healthy / 503 critical) for a free uptime monitor. Distinguishes an unreadable wallet from an empty one. |
| **Mobile/PWA** | E1–E32 hardening — install pitch, in-app-browser read-only handling, iOS Quick Look recovery files, keyboard/viewport work |
| **Rebrand** | BSVibes → OpenCook → **$OpenBooks**; `openbooks.space` live; OG cards, icons, manifesto rewritten |
| **Genesis** | 1,908 backdated posts anchored on-chain (~40 batched txs); 2,006-post launch DB seeds a fresh volume on boot |
| **Threading** | `parent_id` (lineage) + `root_id` (membership), thread overlay, replies target the root |
| **Tokens** | Per-token holder leaderboard (`/leaderboard/$a/$b`), `$Ticker` registry (first-claim-wins, PRIMARY KEY), ticker tree with parent lineage, reserved names, `$Nym` usernames, search + `/tickers` index, media uploads, `ticker_mentions` edge table, wallet holdings |
