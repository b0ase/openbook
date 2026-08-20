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

echo "→ building (cmd/server is package main)"
export PATH="$HOME/go-toolchain/go/bin:$PATH"
go build -o server.run.new ./cmd/server
echo "  server.run.new  $(wc -c < server.run.new) bytes"

# ⚠ A LIBRARY ARCHIVE IS NOT A SERVER. An earlier build produced a 1.6MB .a and
# was very nearly reported as a success. An ELF executable is the only thing
# worth swapping in.
if ! file server.run.new | grep -q "executable"; then
  echo "✗ server.run.new is not an executable — refusing to go further"
  file server.run.new
  exit 1
fi

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
