#!/usr/bin/env node

/**
 * Read a room, with the platform's offline key. The moderation half.
 *
 * ⚠ WITHOUT THIS, HOLDING A KEY TO EVERY ROOM IS THEORETICAL. The point of the
 * platform being a recipient is that the board can be moderated — illegal
 * content removed from what openbooks.space SERVES. That requires actually
 * reading, which requires a deliberate offline act with a key that is not on
 * the server.
 *
 * ⚠ THE KEY IS PASSED IN AT RUN TIME AND NEVER STORED. Read from
 * `PLATFORM_ROOM_WIF` in the environment of THIS invocation only:
 *
 *   PLATFORM_ROOM_WIF=… node scripts/read-room.mjs '$Occam'
 *   PLATFORM_ROOM_WIF=… node scripts/read-room.mjs '$Occam' --limit 50
 *
 * Prefer a shell that does not record the line in history (a leading space on
 * bash/zsh with HIST_IGNORE_SPACE), or export it into a subshell you then close.
 *
 * ⚠ WHAT THIS CANNOT DO: remove anything from Bitcoin. The inscription is
 * permanent and was broadcast by the author's own browser, not by us. What
 * moderation means here is that the board stops serving it — see
 * `scripts/takedown.mjs` for content, and note that for CSAM specifically,
 * REMOVING IS NOT ENOUGH: it must also be reported (UK: IWF and the police;
 * US: NCMEC).
 */

import { PrivateKey } from "@bsv/sdk";
import Database from "better-sqlite3";
import { openSealed, parseSealed } from "../src/lib/room-crypto.ts";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 200;
const symbolArg = args.find((a) => !a.startsWith("--") && a !== String(limit));

if (!symbolArg) {
  console.error("usage: PLATFORM_ROOM_WIF=… node scripts/read-room.mjs '$SYMBOL' [--limit N]");
  process.exit(1);
}
const symbol = symbolArg.replace(/^\$/, "").toUpperCase();

/**
 * Ask for the key without echoing it, and without it touching disk or history.
 *
 * ⚠ THIS EXISTS SO THE SAFE PATH IS THE EASY ONE. The alternative is
 * `PLATFORM_ROOM_WIF=… node scripts/read-room.mjs`, which puts the key in shell
 * history unless you remember a leading space — and the whole point of keeping
 * it off the server is undone by leaving it in `~/.zsh_history` instead.
 *
 * Typed here it lives in this process and dies with it.
 */
async function promptForWif() {
  if (!process.stdin.isTTY) return null;
  process.stderr.write("Platform room key (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    for (const ch of chunk) {
      // Enter — done.
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write("\n");
        return value;
      }
      // Ctrl-C — leave without a key rather than half-reading one.
      if (ch === "\u0003") {
        process.stdin.setRawMode(false);
        process.stderr.write("\n");
        process.exit(130);
      }
      // Backspace.
      if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
        continue;
      }
      value += ch;
    }
  }
  process.stdin.setRawMode(false);
  return value;
}

const wif = process.env.PLATFORM_ROOM_WIF || (await promptForWif());
if (!wif) {
  console.error("");
  console.error("No key given. It is supplied per-invocation and never stored.");
  console.error("Paste it at the prompt, or pipe it from a password manager:");
  console.error("");
  console.error("  PLATFORM_ROOM_WIF=\"$(op read 'op://Private/OpenBooks room key/password')\" \\");
  console.error("    node scripts/read-room.mjs '$Room'");
  console.error("");
  console.error("⚠ Do NOT put it in .env / .env.local — `next dev` loads those, which would");
  console.error("  place the key in the running app's environment. Plain `node` does not read");
  console.error("  them anyway, so it would not even work here.");
  console.error("");
  console.error("Generate the pair with: node scripts/room-keygen.mjs");
  process.exit(1);
}

let pubkey;
try {
  pubkey = PrivateKey.fromWif(wif).toPublicKey().toString();
} catch {
  console.error("PLATFORM_ROOM_WIF is not a valid WIF.");
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH?.trim() || "./local.db";
const db = new Database(dbPath, { readonly: true });

// The room's posts are the thread rooted at the room's ticker. Read broadly and
// filter on what is actually sealed — a room may hold both, and a reader that
// silently skipped plaintext would under-report what the board is serving.
const rows = db
  .prepare(
    `SELECT p.id, p.author, p.content, p.created_at, p.tx_id
       FROM posts p
       JOIN ticker_mentions m ON m.post_id = p.id
      WHERE m.symbol = ?
      ORDER BY p.id DESC
      LIMIT ?`
  )
  .all(symbol, Number.isFinite(limit) && limit > 0 ? limit : 200);

console.log(`room     $${symbol}`);
console.log(`database ${dbPath}`);
console.log(`posts    ${rows.length}`);
console.log("");

let sealedCount = 0;
let unreadable = 0;

for (const r of rows.reverse()) {
  const envelope = parseSealed(r.content ?? "");
  if (!envelope) {
    console.log(`  #${r.id} ${r.created_at} ${r.author} [PLAINTEXT]`);
    console.log(
      `      ${String(r.content ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 300)}`
    );
    continue;
  }
  sealedCount++;
  const text = openSealed(envelope, wif, pubkey);
  if (text === null) {
    /**
     * ⚠ NOT AN ERROR TO SWALLOW. A sealed post the platform cannot open means
     * this room was created before the platform key existed, or under a
     * different one, or the key has been rotated. Those rooms are permanently
     * unmoderatable and that is worth knowing precisely, not glossing.
     */
    unreadable++;
    console.log(`  #${r.id} ${r.created_at} ${r.author} ⚠ SEALED — NOT TO THIS KEY`);
    continue;
  }
  console.log(`  #${r.id} ${r.created_at} ${r.author}`);
  console.log(`      ${text.replace(/\s+/g, " ").slice(0, 300)}`);
}

console.log("");
console.log(`sealed ${sealedCount}, of which ${unreadable} unreadable with this key`);
if (unreadable > 0) {
  console.log("⚠ Unreadable posts were sealed to a DIFFERENT platform key, or none.");
  console.log("  They cannot be moderated. The chain cannot be rewritten.");
  process.exitCode = 2;
}
