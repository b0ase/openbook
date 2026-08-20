# Roadmap

> Where this is, what's next, what's parked. **AI agents: update this file when you finish or start
> something.** Rewritten 2026-08-14, and reconciled against reality on **2026-08-17** — the token
> economy shipped across seven commits that day and this file was not touched once, so it still
> described the inscription milestone as "next" (it passed), listed thread URLs and boost-board
> unfurls as open (both done), and quoted a post price that was wrong by two orders of magnitude.
> A roadmap that lies is worse than no roadmap: the next session plans from it.
>
> **Read order for a new session:** CLAUDE.md → this file → DECISIONS.md → TOKENS.md →
> SESSION_LOG.md (last entry).

## Where this is now

**$OpenBooks is LIVE at `openbooks.space`** (Railway, valid certs, `www` too), serving a 2,006-post
genesis feed that auto-seeds a fresh volume. **841 unit + 322 integration tests**, plus 10 contract
tests in `contracts/`; lint, tsc and a zero-warning production build all green.

**Still a quiet launch.** `robots.txt` serves `Disallow: /` — verified 2026-08-17. Nothing is
indexed until `ALLOW_INDEXING=true`.

**The board works.** Posting, signing, on-chain inscription, boosts, the boost board, earnings,
threads, permalinks, `$Ticker` claiming, `$Nym` names, media uploads (images, video, PDF), search,
the `/tickers` index, and a wallet showing what you hold.

**Three things a reader needs up front:**

1. **We INSCRIBE.** Every post is written to a **1-satoshi spendable output** at the author's
   address inside a 1Sat ordinal envelope, so a post **is** an on-chain object its author can own
   and transfer, identified by its **origin outpoint `<txid>_<vout>`**. Verified against a live
   post and a public indexer, not inferred. The older `OP_FALSE OP_RETURN` anchor was an
   *unspendable* audit trail — the 2,006 genesis records are still exactly that and stay readable.

2. **Posting costs the author money.** `PAID_POSTING` is **ON in production**. A post spends about
   **113 sats — roughly $0.000013 at $11.62/BSV**: 1 sat inscribed, 12 sats to the platform, ~100
   sats fee. ⚠ This file previously said `~$0.0017`, which was wrong by ~130×; sats are the durable
   figure and any dollar number is a snapshot. A funded wallet is a precondition — an unfunded
   account is refused *before* anything is broadcast, so nothing is spent on a refusal.

3. **The token economy shipped on 2026-08-17, and it is a DATABASE LEDGER, not chain state.** This
   is the single most important thing to understand before planning anything:
   - Naming a `$Ticker` mints units, and the mint is **charged on a rising curve**
     (`mint-charge.ts`) — the curve is what an author actually pays, not a display.
   - `/buy N $Ticker` buys many units at once, each priced up the curve (quadratic).
   - **A named thread is a ROOM**; one unit is the ticket in. Writing is gated
     cryptographically; reading is a product boundary, and `room-access.ts` says so rather than
     claiming secrecy — the posts are on chain and readable by anyone who indexes them.
   - Holders can **list units** and buyers can **fill** those listings. Money moves peer to peer;
     the platform never holds it. **But a unit is a row in `ticker_holdings`**, so applying the
     transfer is something the platform is trusted to do. That is a real assumption and must not
     be described as trustless.
   - **The mint price is NOT a ceiling on what a holder may ask.** An ask above it is a limit
     order that fills when the curve rises past it. The mint price is the price of the last resort.

## The next milestone: make the tokens real on chain

**The previous milestone — paid posting + inscription — PASSED on 2026-08-16** (post 2080, tx
`af3436bc…`, confirmed at height 962564, `origin.outpoint` assigned by GorillaPool's indexer).

The gap now is the one in point 3 above: **typing `$newticker` mints nothing on the blockchain.**
The post is a real ordinal and the payment is real sats, but the units are database rows. Closing
that is what removes the trust assumption from resale and turns the room gate into something the
chain enforces.

**BUILT, not deployed** — `contracts/`, an isolated workspace (own `package.json`, own
`node_modules`, excluded from the app's tsconfig; nothing in `src/` may import it):

- [x] **`PayToMint extends BSV20V2`** — POW-20's structure with OrdLock's predicate, which is the
      construction TOKENS.md specced. Supply lives in a contract UTXO; a mint must produce the
      continuation, the units to the minter and the payment to the treasury, bound by
      `hash256(outputs) == ctx.hashOutputs`.
- [x] **Compiles to Bitcoin script; 10 tests pass**, six of them refusals (underpaying by ONE
      satoshi, redirecting the payment, taking more than paid for, dropping the continuation,
      minting zero, minting past supply). The price is asserted equal to the app's own
      `mintCostForRange` across the range.
- [x] **The app can build the covenant's scripts WITHOUT sCrypt** (`covenant-script.ts`,
      2026-08-20). The contract code is copied from the chain rather than templated from the
      compiled artifact — a continuation carries the same code as the input it spends, so only the
      inscription and the state are rebuilt. Verified BYTE-FOR-BYTE against sCrypt in
      `contracts/tests/covenantScript.test.ts` (12 equality cases + a mint the real interpreter
      accepts + a negative control). This was the piece that made the migration research rather
      than construction; it is now construction.
- [ ] **The mint TRANSACTION builder** — sighash preimage, the author's funding inputs, change,
      broadcast. The unlocking script is five pushes and all five are computable:
      `<amount> <minterHash> <preimage> <changeSats> <changeAddrHash>`. The script layer it needs
      is finished.
- [ ] ⚠ **Mints of the same word SERIALIZE — nothing is built for this.** A covenant is one UTXO,
      so two authors naming `$Occam` at the same moment build from the same outpoint and one is a
      double-spend. Posting is fully parallel today. **This is the next real design decision.** It
      does not require custody: only the author's own funding inputs need their signature, so a
      coordinator can assemble an unsigned transaction and have the browser sign its own inputs.
      See DECISIONS "Two measured facts about minting".
- [ ] ⚠ **Deploy a THROWAWAY symbol and confirm an indexer sees deploy + mint + transfer.** Same
      discipline that gated paid posting. **Blocked on funding** — the owner has no testnet coins;
      either a faucet (witnessonchain / scrypt.io) or a mainnet deploy at ~200 sats. The scripts
      refuse a mainnet key today; relaxing that must be a deliberate act, not an accident.
      ⚠ A covenant bug is not a thrown error — it locks a token's unissued supply forever.
- [ ] **Then the migration.** `ticker_holdings` demotes from ledger to an INDEX of chain state,
      resale becomes an OrdLock swap (deleting the trust assumption), the room gate reads an
      indexer rather than a `SELECT`.

## In progress — the market

- [ ] **Sweeping.** Bulk-fill listings up to a price ceiling in one transaction, so an ask set
      above today's mint price fills automatically when the curve rises past it. Needs
      `fillListing` to walk several listings in one payment. **Agreed as the next build.**
- [ ] **Limit / market order UI** in the sell sheet. Only a plain list-at-price form exists.
- [ ] **A platform cut on resale.** Deliberately zero for now — the mint is where revenue is
      taken, and a second toll before anyone has traded would be pricing a market that does not
      exist. Revisit once there is volume.

## Still waiting on a decision

- [ ] **Tagging.** The `(from_post, ticker, target)` edge table is BUILT (`ticker_mentions`,
      `target_type ∈ {none, post, ticker}`). **Nothing writes a targeted row yet.** The original
      objection — free tags would put `$COOL` on everything — has expired now that tags cost real
      sats. What is unsettled is the SPLIT: does tagging mint the tagger a unit, and does the
      tagged post's author get anything?
- [ ] **The payment split.** Top 100 holders, with an amount floor (~10 sats — a UTXO below its own
      spending cost is worth less than nothing). The data is all there; the split is two queries.
      ⚠ Note the standing caveat in TOKENS.md: cash distributions to transferable holders are the
      part a lawyer needs to see.
- [ ] **Citation/quote-minting.** The quoter holds the new unit.
- [x] **Does ordinary posting stay paid, or only minting a ticker?** **SETTLED 2026-08-17, owner:
      *"ordinary posting is paid"*.** No free tier for posts that name nothing. This confirms what
      production already does rather than changing it — the value is that it is no longer an open
      question every new verb has to re-ask. See DECISIONS.md.

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

- [x] **Separator: `/` for lineage, and NO `#` serial.** **SETTLED 2026-08-17** — owner delegated
      the choice. `/` was already consensus (it is in every live URL). `#` is rejected on a concrete
      ground: it is the URL fragment delimiter, so `/$words#42` never reaches the server, and this
      codebase has already been bitten by the encoded-path version of that bug. No serial notation
      is needed anyway — units are fungible (`amt`), and a post-token is already identified by its
      origin outpoint. See DECISIONS.md.
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
      decision about what the board IS, not an implementation detail. ⚠ **Half of this is now
      settled**: ordinary posting is paid (owner, 2026-08-17), so the default for a new verb is
      PAID unless there is a reason it should not be. What is still open per verb is the split, not
      whether it costs.
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

- [x] **Unfurl OG cards on the boost board.** **DONE 2026-08-16** (`0b3c0fe`) — wired into the
      existing preview pipeline. A boosted link currently renders as raw text —
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

**Agent runtime — the one thing stopping it working (found live 2026-08-16):**

- [ ] ⚠ **Server-side spent-outpoint ledger.** Agent replies fail with `broadcast_failed` because
      `/api/unspent` offers an output that is already spent by an unconfirmed transaction.
      Observed for `$Occam`: WhatsOnChain returned BOTH `4aa6731a…` (height 962567, confirmed) and
      `ac6c5b4d…` (height 0) — but the second is the change from a transaction that spent the
      first. A confirmed-looking output whose spender is still in the mempool reads as unspent, so
      the builder selects it, produces a double-spend, and ARC rejects it.
      `client-boot.ts` already blacklists spent outpoints — but it persists to **localStorage**,
      which does not exist on the server, so the runtime keeps only an in-memory copy that every
      deploy wipes. **The blacklist needs a table.** Until then an agent can post roughly once per
      block, and only if the process has not restarted since.
      ⚠ Do NOT "fix" this by preferring unconfirmed UTXOs — that is a heuristic that happens to
      work for a wallet chaining its own change and breaks the moment anything else pays the agent.

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

- [x] **Thread URLs.** **DONE 2026-08-17.** Every open goes through `Feed.openThread()`, which
      pushes `/p/<rootId>`; `popstate` reads it back, so Back closes and Forward reopens. Ticker
      threads keep their `/$ticker` address. Every post also has a permalink (`/p/<id>`) with a
      visible copy-link button and an OG card carrying the post's own words.
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
| **Token economy** *(2026-08-17)* | The mint curve is CHARGED (`mint-charge.ts`, tolerance band for the stale-quote race); `/buy N $Ticker` bulk purchase; rooms (a named thread gated on holding one unit); ownership split out into `ticker_holdings`; a secondary market (`listings` + `listing_fills`, sign-exact-terms, peer-to-peer payment); per-post permalinks + OG cards; `paid_sats` cost basis |
| **Contract** *(2026-08-17)* | `contracts/` — `PayToMint extends BSV20V2`, POW-20 structure + OrdLock predicate. Compiles to Bitcoin script; 10 tests, six of them refusals; price asserted equal to the app's curve. **Not deployed.** |
