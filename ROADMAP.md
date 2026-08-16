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

1. **We INSCRIBE — this went live and both statements below were reversed on 2026-08-16.** Every
   post is written to a **1-satoshi spendable output** at the author's address inside a 1Sat ordinal
   envelope, so a post **is** an on-chain object its author can own and transfer, identified by its
   **origin outpoint `<txid>_<vout>`**. Verified against a live post, not inferred: every post in
   the feed now carries a `vout`. The older `OP_FALSE OP_RETURN` anchor was an *unspendable* audit
   trail — the 2,006 genesis records are still exactly that and stay readable.
2. **Posting costs the author money.** `PAID_POSTING` is **ON in production**. A post spends about
   **113 sats (~$0.0017)**: 1 sat inscribed, 12 sats to the platform address, ~100 sats fee. A
   funded wallet is now a precondition for posting — a fresh unfunded account is refused with
   "No funds yet — add some to post" *before* anything is broadcast, so nothing is spent on a
   refusal. The economic decisions in TOKENS.md are no longer gated on this changing; it changed.

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

- [x] ⚠ **Broadcast ONE inscription and confirm a public indexer shows it.** **PASSED 2026-08-16.**
      Post 2080, tx `af3436bc34fdde906a47cfcea867c4c8a2b0f496d637653528a3a03885ded506`. GorillaPool's
      public indexer (`ordinals.gorillapool.io/api/inscriptions/txid/<txid>`) returns vout 0 as
      1 sat owned by the author with **`origin.outpoint` assigned**, `data.insc.file`
      (564 bytes, `application/json`) and the decoded `data.insc.json` — recognition, not just shape.
      `types: ["json"]`, `spend: ""`. **CONFIRMED IN A BLOCK** — re-checked at height `962564`,
      idx 18: still 1 sat, still owned by the author, origin outpoint intact, still unspent. So this
      is not 0-conf mempool optimism; a public indexer holds a confirmed, ownable, transferable
      post. The `api.1sat.app` host 404s on `/tx`, `/txos/txid` and `/inscriptions/txid`
      — use the GorillaPool host above, it is the one that answers.
- [x] **Compose box wired** — asks `getPostingMode()`, builds + broadcasts, sends `raw_tx`, and
      reports money failures honestly ("nothing was spent") rather than "failed to post".

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

**From the board** (owner posting as `$B0ase`, 2026-08-16 — read the feed regularly and add what
he asks for here; the board is where the asks now arrive):

- [ ] **Bitcoin Schema on posts: like, subscribe, share, reply, tag.** Reply already exists
      (`parent_id` / `getThread` / `ThreadView`), so this is really four new verbs plus adopting a
      standard envelope for them. ⚠ Decide FIRST whether each verb is a *paid on-chain record* or a
      database row. Under `PAID_POSTING` a like that inscribes costs the liker ~113 sats, which is
      a very different product from a free like — and "every like is a paid transaction" is a
      decision about what the board IS, not an implementation detail. See the `$genius` note below:
      the same question decides both.
- [ ] **Tagging a post into a ticker's thread** — "if a user thinks a post needs a tag, they can
      tag it (e.g. `$genius`) and that adds that post to the `$genius` thread". ⚠ **This was
      deliberately blocked, and the reason it was blocked has now expired.** The `ticker_mentions`
      edge table `(from_post, ticker, target)` is built and nothing writes a targeted row, because
      *"free tags would put `$COOL` on everything within a day and the units could never be
      recalled"*. Tags are no longer free — `PAID_POSTING` is on, so a tag costs the tagger a real
      ~113 sats, which is exactly the friction that objection wanted. **The blocker is cleared; the
      open question is now the split, not the spam.** Still to settle: does tagging mint the
      TAGGER a unit of `$genius` (today, citing does — one mention of `$B0ase` minted 33% of it),
      and does the tagged post's author get anything? Answer that before any row is written.

**Boost board presentation** (owner-requested 2026-08-16 — the board is the paid slot, so it is
the one surface where a bare URL costs somebody money):

- [ ] **Unfurl OG cards on the boost board.** A boosted link currently renders as raw text —
      `bitcoinchat.online` is sitting in the paid slot right now with no title, description or
      image, while the SAME link two rows below it in the feed unfurls properly. The feed already
      has all of this: `link-preview.ts`, `link-preview-store.ts` and `LinkPreviewCard`. This is
      wiring the boost board into the existing preview pipeline, not building a second one.
      ⚠ Keep the boost board's own fixed height — an unfurl card is much taller than a line of
      text, and the board sits above the feed where a sudden growth shoves the whole feed down.
- [ ] **Thumbnails for image and video boosts.** Same slot, same reason: a boosted `.mp4` shows as
      a 90-character URL today (see the current `anon_tel5` boost). `media.ts` / `MediaEmbed`
      already classify and render these in the feed. ⚠ A boost must not autoplay video or pull a
      full-size image — the board is persistent and always on screen, so it needs a poster frame
      or a capped thumbnail, not an embed.

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
- [x] **`/agent` inline** — a hash-chained human/AI exchange, server-attested, published (and paid
      for) by the human who asked.
- [ ] **`$Name` agent invocation** — external agents addressed through the ticker namespace, not a
      second registry. Deferred with `$TickerAgents`; see DECISIONS.md.
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
