#!/usr/bin/env node

/**
 * Sweep a candidate CONTENT_DENYLIST for FALSE POSITIVES before it goes live.
 *
 * ⚠ WHAT THIS IS FOR, AND WHY IT IS THE HARDER DIRECTION TO CHECK. A denylist
 * that MISSES something fails loudly the moment somebody notices. A denylist
 * that BLOCKS LEGAL SPEECH fails silently: the author sees a refusal, nobody
 * else sees anything, and no log says which pattern did it. On a board whose
 * whole proposition is that you own what you post, that is the worse failure —
 * and DECISIONS.md is explicit that over-blocking cuts against the ethos.
 *
 * This has bitten already. A `/seed phrase/` pattern blocked the app's OWN
 * safety copy — *"Never share your seed phrase with anyone, including
 * support"* — because a text filter matches words, not intent.
 *
 * So the method is simply: run the candidate over a corpus that is KNOWN GOOD,
 * and treat every hit as a false positive by definition. The corpus is every
 * post the board already has, plus the project's own prose, which is exactly
 * where the trip hazards live (documents that DISCUSS the things being
 * blocked).
 *
 *   node scripts/denylist-check.mjs <candidate-file>
 *   node scripts/denylist-check.mjs <candidate-file> --db seed/genesis.db
 *   EXISTING="$(railway variables --json | jq -r .CONTENT_DENYLIST)" \
 *     node scripts/denylist-check.mjs <candidate-file>   # check the COMBINED list
 *
 * ⚠ A CLEAN SWEEP PROVES ONE THING ONLY: that this list does not block what we
 * already have. It says NOTHING about whether the list catches what it is meant
 * to catch — no corpus of the real thing exists here, and should not. Coverage
 * is a separate question with a separate answer (a licensed hash list; see
 * `scripts/block-hashes.mjs`).
 *
 * ⚠ AND IT IMPORTS THE APP'S OWN `screenContent`. Re-implementing the matching
 * here would mean two definitions of what a pattern means, and the one being
 * tested would be the wrong one.
 */

import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { screenContent } from "../src/lib/content-filter.ts";

const args = process.argv.slice(2);
const candidateFile = args.find((a) => !a.startsWith("--"));
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : "seed/genesis.db";

if (!candidateFile) {
  console.error("usage: node scripts/denylist-check.mjs <candidate-file> [--db path]");
  process.exit(1);
}

const candidate = readFileSync(candidateFile, "utf8");
// The live list is what actually runs, so a candidate is only meaningful when
// checked as it will be DEPLOYED — appended to whatever is already set, never
// replacing it. Pass the current value in EXISTING to sweep the real thing.
const existing = process.env.EXISTING ?? "";
const combined = [existing, candidate].filter((s) => s.trim()).join("\n");

const hits = [];

const db = new Database(dbPath, { readonly: true });
const posts = db.prepare("SELECT id, content FROM posts").all();
for (const p of posts) {
  const text = p.content ?? "";
  if (text && !screenContent(text, combined).ok) {
    hits.push([`post ${p.id}`, text]);
  }
}

// The project's own prose, paragraph by paragraph. Documents ABOUT illegal
// content are the likeliest thing a filter for illegal content will flag.
const docs = [];
for (const f of readdirSync("legal")) {
  docs.push([`legal/${f}`, readFileSync(`legal/${f}`, "utf8")]);
}
// ⚠ LAUNCH_CHECKLIST.md is deliberately NOT here. It QUOTES denylist patterns
// verbatim to document them, so it matches itself and reports a false positive
// that is nothing of the kind. A document about the filter is not content the
// filter is for.
for (const f of ["CLAUDE.md", "DECISIONS.md", "TOKENS.md", "DEPLOY.md"]) {
  try {
    docs.push([f, readFileSync(f, "utf8")]);
  } catch {
    // Temporary files (LAUNCH_CHECKLIST is git rm'd at launch-close) — skipping
    // one is fine; failing the sweep because a doc moved is not.
  }
}
for (const [name, text] of docs) {
  for (const para of text.split(/\n{2,}/)) {
    if (para.trim() && !screenContent(para, combined).ok) hits.push([name, para]);
  }
}

console.log(`candidate  ${candidateFile}`);
console.log(`existing   ${existing ? `${existing.length} chars (from EXISTING)` : "not supplied"}`);
console.log(`corpus     ${posts.length} posts (${dbPath}) + ${docs.length} documents`);
console.log("");

if (hits.length === 0) {
  console.log("✅ NO FALSE POSITIVES — nothing known-good was blocked.");
  console.log("   This does NOT show the list catches anything. See the note at the top.");
  process.exit(0);
}

console.log(`❌ ${hits.length} FALSE POSITIVE(S) — do not ship this list:\n`);
for (const [where, text] of hits.slice(0, 40)) {
  console.log(`  ${where}`);
  console.log(`    ${text.slice(0, 160).replace(/\s+/g, " ")}`);
}
if (hits.length > 40) console.log(`  …and ${hits.length - 40} more`);
process.exit(1);
