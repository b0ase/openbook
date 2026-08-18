# ops

Source that belongs to **other machines**, kept here so it is version-controlled
and reviewable rather than living only in someone's shell history on a box.

Nothing in this directory is part of the app. It is not compiled, not imported,
and not shipped. `next build` never sees it.

## `overlay-admin.go`

Destination: **`~/src/bsv21-heroku/cmd/server/admin.go`** on the Hetzner box
(`ssh hetzner`), which is the BSV-21 overlay's source tree. ⚠ Not
`~/src/bsv21-overlay` — that is a stale checkout that builds a different binary,
and patching it wastes an afternoon.

### What it does and why it has to exist

The overlay indexes only whitelisted tokens, and until now the only way to add
one was a command typed on that box. $OpenBooks mints one token per *word*, from
a browser, the moment somebody types it — so a mint cannot whitelist itself, and
a token the overlay has never heard of is indistinguishable from a token with no
holders. This is one authenticated route that closes that gap. See DEPLOY.md,
"IT INDEXES ONLY WHITELISTED TOKENS".

### Installing it

It is a new file plus one call. In `cmd/server/server.go`, immediately after the
`server.RegisterRoutes(app, &server.RegisterRoutesConfig{…})` block:

```go
RegisterAdminRoutes(app, store)
```

Then, from `~/src/bsv21-heroku`:

```sh
go build -o server.run.new ./cmd/server   # cmd/server IS package main
mv server.run.new server.run              # mv, not cp — cp over a running binary is "Text file busy"
pm2 restart bsv21-overlay
```

Set `OVERLAY_ADMIN_TOKEN` in the process environment first. **Without it the
route is not registered at all** — deliberately, so an operator who has not opted
in has no endpoint to probe rather than one that always refuses.

⚠ Back the binary up before swapping. There are already `server.run.bak-*` and
`cmd/server/server.go.bak-*` from the `OctetStreamLimit` fix on 2026-08-18.
