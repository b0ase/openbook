#!/usr/bin/env bash
#
# Install the whitelist admin route on the BSV-21 overlay box.
#
# ⚠ RUN THIS ON THE OVERLAY HOST, and the safe way to do that is not to think
# about it — pipe it there in one line from anywhere:
#
#   ssh hetzner 'bash -s' < ops/install-overlay-admin.sh
#   ssh hetzner 'bash -s' < ops/install-overlay-admin.sh -- --swap
#
# A bare `curl … -o ~/src/…` handed over as a paste has already been run on the
# wrong machine once, where the directory does not exist and `curl -s` swallowed
# the error, so it looked like it worked. This refuses to run anywhere that is
# not the box.
#
# WHAT IT IS FOR. The overlay indexes only tokens it has been told about, and
# $OpenBooks mints one token per WORD, from a browser, the moment somebody types
# one. `Submit` returns ErrUnknownTopic for a topic with no manager (verified in
# engine.go), so a mint cannot bootstrap its own indexing and every such token
# reads as "no holders" — indistinguishable from a correct empty answer.
#
# WITHOUT --swap it stops before touching the running service: it fetches,
# patches, builds, and tells you what it would do. That is deliberate. Swapping
# a live binary is the one step worth doing with your eyes open.

set -euo pipefail

SRC="$HOME/src/bsv21-heroku"
RAW="https://raw.githubusercontent.com/b0ase/openbook/master/ops/overlay-admin.go"
STAMP="$(date +%Y%m%d-%H%M%S)"
SWAP=0
for a in "$@"; do [ "$a" = "--swap" ] && SWAP=1; done

if [ ! -d "$SRC/cmd/server" ]; then
  echo "✗ $SRC/cmd/server does not exist."
  echo "  This is meant to run on the overlay HOST, not on a laptop:"
  echo "    ssh hetzner 'bash -s' < ops/install-overlay-admin.sh"
  exit 1
fi

# ⚠ NOT ~/src/bsv21-overlay. That is a stale checkout which builds a different
# binary, and patching it cost an afternoon once already.
echo "→ tree     $SRC"
cd "$SRC"

echo "→ fetching admin route"
curl -fsSL "$RAW" -o cmd/server/admin.go
echo "  cmd/server/admin.go  $(wc -c < cmd/server/admin.go) bytes"

# The one-line wiring, inserted idempotently. Anchored on the comment that
# FOLLOWS the RegisterRoutes block rather than on the block itself, because the
# block's contents have changed once already (OctetStreamLimit) and will again.
if grep -q "RegisterAdminRoutes(app, store)" cmd/server/server.go; then
  echo "→ server.go already wired, leaving it alone"
else
  cp cmd/server/server.go "cmd/server/server.go.bak-$STAMP"
  python3 - <<'PY'
import io, sys
p = "cmd/server/server.go"
s = open(p).read()
anchor = "\t// Register headers webhook route"
if anchor not in s:
    sys.exit("✗ could not find the insertion anchor in server.go — wire it by hand")
ins = (
    "\t// b0ase: authenticated whitelist route, so a mint can index itself.\n"
    "\t// Registers NOTHING when OVERLAY_ADMIN_TOKEN is unset. See ops/README.md.\n"
    "\tRegisterAdminRoutes(app, store)\n\n"
)
open(p, "w").write(s.replace(anchor, ins + anchor, 1))
print("  server.go patched")
PY
fi

# ── Patch 2: a not-found that reports itself as a server fault ───────────────
#
# ⚠ A REAL BUG, FOUND BY REFUSING TO CALL A 500 "PRE-EXISTING". The token
# details route has an explicit not-found branch, but it compares
# `err.Error() == "token not found"` — and the storage layer returns
# **"outpoint not found"** (overlay/storage/{sqlite,postgres,mongo}.go). The
# exact match never fires, so every genuine not-found falls through to the 500
# catch-all: "Failed to retrieve token details".
#
# ⚠ WHY IT MATTERS TO US SPECIFICALLY. `src/services/indexer/overlay.ts` reads
# these status codes as MEANINGS: 503 = never whitelisted, 404 = tracked but no
# data yet, 5xx = the indexer is unwell. With this bug a token that is tracked
# and simply has nothing yet is indistinguishable from a broken indexer — and
# the app is built to never turn either into a balance, so it would report
# "unreachable" forever for a token that is merely empty.
if grep -q 'err.Error() == "token not found"' routes/bsv21.go; then
  cp routes/bsv21.go "routes/bsv21.go.bak-$STAMP"
  python3 - <<'PY2'
p = "routes/bsv21.go"
s = open(p).read()
old = 'if err.Error() == "token not found" {'
new = 'if strings.Contains(err.Error(), "not found") {'
assert old in s
open(p, "w").write(s.replace(old, new, 1))
print("  routes/bsv21.go patched — not-found now answers 404, not 500")
PY2
else
  echo "→ routes/bsv21.go already patched, leaving it alone"
fi

echo "→ building (cmd/server is package main)"
export PATH="$HOME/go-toolchain/go/bin:$PATH"
go build -o server.run.new ./cmd/server
echo "  server.run.new  $(wc -c < server.run.new) bytes"

# ⚠ A LIBRARY ARCHIVE IS NOT A SERVER. An earlier build produced a 1.6MB .a and
# was very nearly reported as a success, so the output is checked rather than
# assumed.
#
# ⚠ AND THE CHECK ITSELF HAS ALREADY BEEN WRONG ONCE. It used `file`, which is
# not installed on this box — so a perfectly good 58MB binary was declared "not
# an executable" and a working install was refused. A guard that fails when its
# own tooling is missing is worse than no guard: it stops correct work and
# points at the wrong thing.
#
# So: compare magic bytes against the binary ALREADY RUNNING. No external
# tools, no assumptions about platform or format — whatever the live server is,
# the new one has to be the same kind of file.
new_magic="$(head -c 4 server.run.new | od -An -c | tr -d ' \n')"
run_magic="$(head -c 4 server.run    | od -An -c | tr -d ' \n')"
if [ "$new_magic" != "$run_magic" ]; then
  echo "✗ server.run.new does not look like the running binary — refusing to go further"
  echo "  running: $run_magic"
  echo "  built:   $new_magic"
  exit 1
fi
echo "  magic matches the running binary ($run_magic)"

if [ "$SWAP" -eq 0 ]; then
  echo ""
  echo "Built, not installed. To install:"
  echo "    ssh hetzner 'bash -s' < ops/install-overlay-admin.sh -- --swap"
  echo ""
  echo "First set the token, or the route registers nothing:"
  echo "    pm2 set OVERLAY_ADMIN_TOKEN <a-long-random-string>   # or however this env is fed"
  exit 0
fi

echo "→ backing up the running binary"
cp server.run "server.run.bak-$STAMP"
# ⚠ mv, NOT cp. Copying over a running binary gives "Text file busy"; a rename
# on the same filesystem swaps the inode and the old process keeps its own.
mv server.run.new server.run
echo "→ restarting"
pm2 restart bsv21-overlay
sleep 3
pm2 describe bsv21-overlay | grep -E "status|uptime" || true
echo ""
echo "✓ installed. Verify (from anywhere):"
echo "    curl -s -H \"Authorization: Bearer \$OVERLAY_ADMIN_TOKEN\" \\"
echo "      https://api.b0ase.com/bsv21/api/v1/admin/whitelist"
