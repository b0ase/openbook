# Deploying OpenBook

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
Error: OpenBook DB: failed to open local.db — unable to open database file
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

## The Vercel project is a redirect, nothing more

`vercel.json` catches every path and forwards it to the Railway origin. The Next.js app still
builds there (the build succeeds — only *runtime* DB access fails), but no request ever
reaches a function, because Vercel applies redirects at the edge.

**Why a redirect and not a proxy.** A Vercel `rewrite` would keep the `*.vercel.app` URL in
the address bar, which looks nicer and is the wrong trade. Every per-IP cap in this app — the
200/day post cap, the free-boot cap, the agent rate limit — keys on `x-forwarded-for`. Put a
second proxy in front and the app stops seeing real client IPs, so the caps stop separating
users. Those caps are what stand between the server wallet and a drain, so a rewrite is a
security regression dressed as a cosmetic improvement. See CLAUDE.md "Deployment Notes".

**Two rules, and they must stay two.** The bare root needs its own entry: `/:path*` is
zero-or-more so it reads as though it covers `/`, and it does not — the symptom is deep links
forwarding correctly while the homepage keeps serving a stale ISR page from the edge.

**No comments inside a redirect object.** `vercel.json` is schema-validated *before* the
build is provisioned, and a redirect accepts only `source`, `destination`, `permanent`,
`statusCode`, `has`, `missing`. A `"//"` comment key — which is harmless in `package.json` —
fails the whole deployment with **no build logs at all**, because it never reaches the build
step. If a Vercel deploy shows `ERROR` with an empty log, suspect the config, not the code.

⚠ **NEVER point a redirect at a host that Vercel itself serves.** An attempt to forward the
`*.vercel.app` URL to `openbooks.space` took the site down with a 307 loop: `openbooks.space`
is served BY Vercel, so it matched the rule and was redirected to itself. Host conditions were
supposed to prevent that, but `/:path*` does not match the bare root (see below), so `/` fell
through to the unconditional rule. Every destination here must be the Railway origin until DNS
moves — at which point Vercel stops seeing this domain at all and the question disappears.

**The domain lives on the WRONG SIDE right now.** `openbooks.space` uses Vercel's nameservers
and is served by Vercel, so it hits these redirects and bounces to the Railway URL. No Vercel
config can fix that — Vercel cannot run this app at all (see above). **The fix is DNS:** add
`openbooks.space` as a custom domain in Railway, then point the record at Railway's CNAME
target from Vercel's DNS panel (Vercel's nameservers are perfectly happy to serve a record
aimed elsewhere). Once traffic goes straight to Railway, the domain serves the app directly —
no redirect, real client IPs, and the OG card comes from the app itself.

Until then the first two rules keep `openbooks.space` working by forwarding it, and the last
two send the old `*.vercel.app` URL to `openbooks.space` so the throwaway link points at the
permanent home. After the DNS move Vercel never sees `openbooks.space` traffic and those first
rules simply stop applying.

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
