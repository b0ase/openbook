# Deploying OpenBooks

> Durable deployment reference. The launch-day do-list lives in LAUNCH_CHECKLIST.md
> (temporary); this file is the part that stays true afterwards.

## The one constraint that decides everything

**This app is stateful by design.** `better-sqlite3` opens a real file on a real disk,
**synchronously**, from module scope — `src/lib/db.ts` runs at import, so a failure to open
the file takes down every route that touches data, at import time, before any handler runs.

That single fact rules hosts in and out:

| Host | Works? | Why |
|---|---|---|
| **Railway** (current) | ✅ | Volume mounted at `/data`, `DATABASE_PATH=/data/local.db` |
| **Any Docker host** (Hetzner, VPS) | ✅ | Bind-mount a host directory to `/data` |
| **Fly, Render, any box with a disk** | ✅ | Same shape — persistent filesystem |
| **Vercel** | ❌ | **Structurally cannot work.** See below. |

### Why Vercel cannot host this

Serverless functions get a **read-only filesystem outside `/tmp`**, and `/tmp` is
per-instance and wiped between invocations. There is nowhere to put the database. The
observed failure is not subtle:

```
Error: OpenBooks DB: failed to open local.db — unable to open database file
    at module evaluation (.next/server/chunks/…)
```

— on `/api/posts`, `/api/earnings`, and the `createPost` server action, every request.
The genesis seed never runs there either: it is an npm `prestart` hook, and Vercel never
invokes `npm start`.

**This is not a bug to fix.** Making it work means replacing SQLite with a network database,
which means every `db.prepare(...).get()` in the codebase becomes `await` — including
`weights.ts`, `pricing.ts`, `boot-orchestrator.ts` and `anchor-sweep.ts`, i.e. the code that
moves money. That is a large refactor with real regression risk on the money path, taken on
in order to use a host that offers nothing this app needs. **Don't.**

---

## Railway (current production)

Already configured; `railway.toml` is committed. What matters:

- **Volume attached at `/data` in the dashboard.** The `[deploy.volumes]` TOML alone does
  NOT create it — attach it in the dashboard *and* redeploy.
- **`DATABASE_PATH=/data/local.db`** — without it the DB lands on the ephemeral container
  filesystem and every deploy silently loses all posts.
- **`startCommand` is not shell-wrapped.** Never use `;` or `&&` there — `node` receives the
  whole string as a filename and nothing serves. Sequence via npm lifecycle hooks; that is
  why seeding is a `prestart` hook rather than part of the start command.
- **Healthcheck path stays `/`**, not `/api/health` — the latter returns 503 by design when
  a critical condition trips, which Railway would read as a failed deploy.

## Docker host (Hetzner or any VPS)

`docker-compose.yml` is committed and self-contained:

```bash
cp .env.example .env      # fill in the secrets — NEVER commit this file
docker compose up -d --build
```

Two choices in that file are load-bearing, both explained inline:

- **The port binds to `127.0.0.1`, not `0.0.0.0`.** Put Caddy or nginx in front for TLS.
  This is a security requirement, not just a convenience: every per-IP rate limit in the app
  (post caps, free-boot cap, agent limits) reads `x-forwarded-for`, which is a
  **client-supplied header**. Behind a proxy that sets it, it is trustworthy. Exposed
  directly, anyone can spoof it and walk straight through every cap.
- **`/data` is a bind mount (`./data`), not a named volume**, so the SQLite file is a plain
  path on the host. The database is the only thing here that cannot be rebuilt from the repo,
  so backing it up should be a `cp`, not a docker volume export.

Minimal Caddy front (sets `X-Forwarded-For` automatically, gets TLS automatically):

```
openbook.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Backups

The DB is the only irreplaceable artifact. With the bind mount:

```bash
sqlite3 ./data/local.db ".backup './data/backup-$(date +%F).db'"
```

Use `.backup` rather than `cp` — the app runs in WAL mode, so a naive copy of a live database
can capture a torn state.

---

## The BSV-21 indexer (external dependency — recorded 2026-08-17)

**Nothing in this repo depended on an indexer until the pay-to-mint covenant went live.** Now
one word typed on the board is one token on chain, and *a BSV-21 token's state is not enforced
by miners — it is whatever an indexer says it is.* So the indexer is not a nice-to-have
alongside the money path; past the migration it **is** the money path, and it belongs in the
deployment reference rather than in someone's memory.

We run our own. It lives in a different repository and was undocumented here — recorded now so
the next session does not have to ask.

| | |
|---|---|
| What | `bsv21-overlay`, a Go BSV-21 indexer — `github.com/b-open-io/bsv21-overlay` |
| Host | Hetzner, `ssh hetzner`, user `deployer` |
| Process | **pm2**, `bsv21-overlay` — *not* a container, so `docker ps` shows nothing |
| Listens | `127.0.0.1:3055`, nginx-exposed at `https://api.b0ase.com/bsv21/` |
| Read | `GET /bsv21/api/1sat/bsv21/<txid>_<vout>` |
| Submit | `POST /bsv21/api/v1/submit` — ⚠ **not** `/bsv21/submit`, see below |
| Admin | `~/src/bsv21-heroku/config.run` on the box — ⚠ **not** `server.run` |
| Source | `~/src/bsv21-heroku` on the box — ⚠ **not** `~/src/bsv21-overlay`, which is a stale checkout that builds a different binary |
| Operator | the owner. Same box as bit-sign's self-hosted Supabase. |

Full runbook — failure modes, the watchdog, the CLI — lives with the project that built it:
`bit-sign/docs/RUNBOOK-bsv21-overlay.md`. Do not fork that document; link to it.

**Verified reachable from the public internet on 2026-08-17** (`503 {"message":"Topic not
available"}` on a read — which is the service answering, see below). So Railway can read it.

### ⚠ IT INDEXES ONLY WHITELISTED TOKENS, AND THAT IS AN UNSOLVED PROBLEM FOR US

Every token must be added by hand on the box before the overlay will touch it:

```bash
./config.run whitelist-add -token <txid>_<vout>
```

Anything else returns **503 `Topic not available`**. That gate is deliberate and correct for
the overlay — it is what makes a public `/submit` endpoint safe and keeps disk bounded.

It is also **directly at odds with how this board works.** $OpenBooks mints one token per word,
from the browser, at the moment somebody types it. A mint originating in the app cannot
whitelist itself, and a token the overlay has never heard of is indistinguishable from a token
with no holders.

#### RESOLVED IN PRINCIPLE (2026-08-18) — and two of the three options were never real

Reading the overlay's source settled it. **The whitelist is a Redis set** (`bsv21:whitelist`),
and `whitelist-add` is one line — `queueStore.SAdd(ctx, constants.KeyWhitelist, tokenID)`.
More importantly, `peer.RegisterTopics` is called from **a 30-second ticker** in
`cmd/server/server.go`, not once at boot: managers are created and destroyed as the set
changes. **So an add takes effect within 30 seconds and needs no restart.**

Of the three options previously listed:

1. **an authenticated admin endpoint on the overlay** — the only real one, and now written
   (`cmd/server/admin.go`, `POST /api/v1/admin/whitelist`, bearer token, fail-closed when
   `OVERLAY_ADMIN_TOKEN` is unset, so an operator who has not opted in has no endpoint to
   probe). ⚠ **Written but NOT YET INSTALLED** — the copy to the box was refused, see below.
2. **an SSH-triggered hook** — strictly worse. It means a private key for the box in Railway's
   environment, trading a scoped bearer token for shell access to the host.
3. **pre-whitelisting** — **impossible by construction.** A BSV-21 token's id *is* its deploy
   outpoint, which cannot be known before the deploy transaction exists. There is nothing to
   pre-register.

So there was one option, not three.

#### ⚠ Three more corrections, all of which cost a round trip to find

- **`/submit` had NEVER worked**, on any token. `cmd/server/server.go` omitted
  `OctetStreamLimit` from `server.RegisterRoutesConfig`, Go zero-valued it, and the middleware
  refused every body against a limit of **0 bytes**. Fixed and deployed 2026-08-18
  (`OctetStreamLimit: 1 << 30`).
- **The submit route wants `x-topics: tm_<txid>_<vout>`**, and the body must be **plain binary
  BEEF** (magic `0100beef`) — not a raw transaction and not Atomic BEEF. WhatsOnChain serves
  BEEF at `/v1/bsv/main/tx/<txid>/beef` but as **hex text**, so it must be decoded to bytes
  first.
- **`/submit` broadcasts.** It is built for live transactions, so an already-mined one is
  refused ("failed to broadcast"). This does not block anything: the overlay follows new
  blocks, so tokens minted from the app *going forward* index live. Backfilling a historic
  token needs a GASP peer that has it, or `server.run -s`.

- ⚠ nginx's `/bsv21/` location sets no `client_max_body_size`, so it inherits the **1 MB**
  default. Our transactions are far smaller, but a BEEF body carrying a deep merkle path is
  not obviously bounded — if a submit ever fails with `413`, that is where it is.

### ⚠ AN EMPTY ANSWER AND A CORRECT ANSWER LOOK IDENTICAL

The failure this indexer is most likely to hand us is not an error. It is a room whose holders
all quietly vanish because the overlay was pointed at before it had the data. bit-sign's
`token-register.ts` carries the same warning at the top for the same reason. When we do switch,
the order is: whitelist the token → submit the deploy → **confirm the read answers with real
data** → only then point the app at it.

Related trap, worth knowing before we write a client: the overlay's route shape is **not**
GorillaPool's. `/api/1sat/bsv21/<id>` here; `/api/bsv20/id/<id>/holders` there. They are not
drop-in substitutes for one another, whatever an env var suggests.

### What the read API actually offers (read from `routes/bsv21.go`, 2026-08-18)

The client is `src/services/indexer/overlay.ts`. Three findings shaped it, and each would
otherwise have been discovered by shipping something wrong:

- **There is no "who holds this token" route.** Every balance is keyed
  `p2pkh:<address>:<tokenId>`, so a question must NAME an address. We can ask *does this person
  hold it*; we cannot ask *who holds it*. A holder list is therefore ours to assemble from
  addresses we already know — and it can never include a holder who has never used this
  platform. That is a real limit on the leaderboard, not a temporary one.
- **The batch `POST …/:lockType/balance` is a SUM, not a map.** It builds one event per address
  and calls `GetBalance(ctx, events, topic)`, which adds them all together and returns a single
  figure. It answers "how much do these people hold between them". Attributing it to any one
  address overstates that holder by everyone else's units. Per-holder numbers need one request
  each. The client names it `combinedBalance` for this reason.
- **`p2pkh` is the only lock type indexed by address.** `lookups/bsv21-events-lookup.go` decodes
  the script suffix and emits nothing for anything else — including the pay-to-mint covenant's
  own continuation output, which is correct, since a contract is not an address.

And the status codes carry meaning worth preserving: **503** is "never told about this token",
**500** is "tracked, no data yet" (observed on both whitelisted test tokens), **200 + balance 0**
is a real zero *only if* the token has finished syncing. None of the three is interchangeable
with the others and none of them is a reason to write down zero.

---

## The DNS cutover, and what it cost to get wrong (done 2026-08-14)

`openbooks.space` and `www.openbooks.space` are served **directly by Railway**. Vercel is out of
the request path entirely; `vercel.json` and its redirect layer have been deleted, because they
existed only to forward the domain while it still resolved to Vercel.

The domain's **nameservers are still Vercel's** (`ns1/ns2.vercel-dns.com`), which is fine and
unrelated: Vercel DNS is happy to serve records pointing anywhere. Records live there, traffic
does not.

| name | type | value |
|---|---|---|
| `@` | ALIAS | `a441ru4w.up.railway.app` |
| `_railway-verify` | TXT | `railway-verify=…` |
| `www` | CNAME | `6tio00gy.up.railway.app` |
| `_railway-verify.www` | TXT | `railway-verify=…` |

**⚠ THE VERIFICATION TXT GOES AT `_railway-verify`, NOT AT THE APEX.** This cost hours. Railway's
dashboard shows the TXT *value* in a panel whose "Name" column is ambiguous, and it reads as
though the record belongs at the root. It does not. With the TXT at `@` the domain sits at
*"Waiting for DNS update"* indefinitely while `dig` shows a TXT that looks perfect — the record
exists, the value is byte-correct, and it is simply at the wrong name. Symptoms: Railway's edge
answers, serves its `*.up.railway.app` **wildcard certificate** (so browsers show
`ERR_CERT_COMMON_NAME_INVALID`) and returns **404**, because the edge routes by Host header and
does not recognise a hostname it never verified.

**Get the records from the CLI, not the dashboard.** `railway domain <host>` prints the exact
type/name/value triples with no ambiguity, and `railway domain status <id>` prints them again for
an existing domain. One command would have replaced every theory below.

**Things that are NOT the cause, ruled out with evidence — do not re-investigate:**

- **CAA.** Vercel's default set already includes `letsencrypt.org`, which is what Railway issues
  through. Adding another CAA record does nothing; adding a *restrictive* one would actively
  block issuance.
- **Apex vs CNAME.** A bare `CNAME` at an apex is illegal, so Vercel serves an `ALIAS` flattened
  to an `A` record. This was my leading theory — that Railway's verifier could not find a literal
  CNAME — and it is **wrong**. The apex verified within a minute once the TXT was moved. Both
  hosts now work; apex-on-Railway is not a limitation.
- **HSTS.** `Strict-Transport-Security` with `includeSubDomains; preload` means a browser will
  NOT let you click through the certificate warning while this is broken. That is correct
  behaviour and not a symptom of anything — it only means you cannot test by ignoring the error.

**⚠ SET `SITE_ORIGIN` TO THE CANONICAL HOST.** Without it the app falls back to
`RAILWAY_PUBLIC_DOMAIN`, so social cards *and upload URLs* carry the `*.up.railway.app` hostname.
An upload URL is written into post text and anchored on-chain verbatim, so that one cannot be
corrected afterwards. Set it in the **dashboard** — `railway variables --set` prints the entire
variable table, including `BSV_SERVER_WIF`.

### The redirect layer that used to live here

Kept only as a warning, since the config is gone. While the domain pointed at Vercel, a
`vercel.json` forwarded every path to the Railway origin. Two traps it taught:

- **`/:path*` does not match the bare root.** It reads as zero-or-more and is not. The symptom is
  deep links forwarding correctly while the homepage serves a stale edge page. An explicit `/`
  rule was always required.
- **Never point a redirect at a host the same platform serves.** Forwarding the `*.vercel.app`
  URL to `openbooks.space` — then served BY Vercel — matched its own rule and took the site down
  with a 307 loop.

**Why a redirect and never a rewrite.** Recorded because it still applies to any future proxy:
every per-IP cap in this app (the 200/day post cap, the free-boot cap, the agent rate limit) keys
on `x-forwarded-for`. A second proxy in front means the app stops seeing real client IPs and the
caps stop separating users. Those caps are what stand between the server wallet and a drain, so a
rewrite is a security regression dressed as a cosmetic improvement.

**Why 307 and not 308.** The destination is an auto-generated Railway subdomain that gets
replaced the moment a real domain is attached. A permanent redirect is cached by browsers
indefinitely, so a 308 would pin every visitor to a URL intended to be thrown away, with no
way to unstick them. **When a real domain lands on Railway, update `destination` here** — or
delete the Vercel project entirely, which is the better end state.

---

## Environment variables

See `.env.example` for the full annotated list. The ones that decide whether a deploy is
correct rather than merely running:

| Variable | Consequence if wrong |
|---|---|
| `DATABASE_PATH` | Unset → DB on ephemeral storage → **all posts lost on every deploy** |
| `BSV_SERVER_WIF` | Unset → posts save but never anchor on-chain (`tx_id` stays NULL) |
| `LAUNCH_TS` | Unset → fail-closed far-future sentinel → **nobody earns from the pool** |
| `ALLOW_INDEXING` | Unset → `noindex`. Set `true` only at go-public |
| `CONTENT_DENYLIST` | Unset → the pre-publish screen is a no-op. Set before inviting posters |

## First boot

`scripts/seed-if-empty.mjs` (the `prestart` hook) copies `seed/genesis.db` into
`DATABASE_PATH` **only when the target is missing or empty**. It never overwrites a database
that has posts, and it fails toward preserving a corrupt or locked one. So it is safe to
leave enabled forever — on an established deploy it is a no-op.

Verify a deploy is actually healthy, not just serving:

```bash
curl -s https://<host>/api/health     # ok:true, addressConfigured:true
curl -s https://<host>/api/posts | head -c 200   # newest post id
```
