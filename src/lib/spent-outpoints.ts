import { type SpentOutpointStore, setSpentOutpointStore } from "@/services/bsv/client-boot";
import { db } from "./db";

/**
 * Durable spent-outpoint blacklist for the server.
 *
 * ⚠ THIS IS WHAT LETS A SERVER SPEND TWICE. WhatsOnChain reports a CONFIRMED
 * output as unspent for as long as the transaction spending it sits in the
 * mempool. Offered that output again, the builder produces a double-spend and
 * ARC rejects it — so without this an agent could post once and then fail every
 * subsequent time until a block confirmed. The browser has always avoided this
 * by blacklisting spent outpoints in localStorage; a server has no localStorage,
 * so its blacklist lived in memory and every deploy wiped it.
 *
 * ⚠ SCOPED BY ADDRESS, AND THAT IS LOAD-BEARING. Both consumers prune by
 * fetching one address's UTXO set and dropping blacklisted outpoints the
 * response no longer contains. That inference is only valid for outpoints
 * belonging to that address. This process spends from the platform wallet and
 * from every configured agent's key, so an unscoped set is one where whichever
 * address was fetched most recently silently clears everyone else's. See the
 * migration note in `db.ts`.
 *
 * ⚠ TWO CONSUMERS, ONE TABLE, DIFFERENT ROUTES IN.
 *
 *  - `client-boot.ts` is shipped to browsers, so it may not import this module —
 *    that would drag `better-sqlite3`, a native module, into the client bundle.
 *    It receives a store through `setSpentOutpointStore` instead and never
 *    learns what a database is.
 *  - `wallet.ts` is server-only (it holds `BSV_SERVER_WIF`), so it calls the
 *    functions below directly.
 *
 * They keep separate in-memory sets because they are separate wallets. The table
 * is shared because an outpoint is globally unique and one row per spend is
 * simpler to reason about than two tables that must agree.
 */

/** Older than this and the spending transaction has certainly confirmed. */
const PRUNE_AFTER = "-3 days";

/**
 * Every outpoint this server knows it has already spent from `address`.
 *
 * Prunes on read: it is the only moment we are certainly on a server, in a
 * request, with the table open — and the set only has to outlive a mempool, not
 * to be a permanent record.
 *
 * ⚠ NEVER THROWS. An empty blacklist costs a rejected broadcast; a throw here
 * would take down the thing that was trying to post. That trade only works in
 * this direction — see `recordSpentOutpoints`.
 */
export function loadSpentOutpoints(address: string): string[] {
  if (!address) return [];
  try {
    db.prepare(`DELETE FROM spent_outpoints WHERE spent_at < datetime('now', ?)`).run(PRUNE_AFTER);
    const rows = db
      .prepare("SELECT outpoint FROM spent_outpoints WHERE address = ?")
      .all(address) as Array<{ outpoint: string }>;
    return rows.map((r) => r.outpoint);
  } catch {
    return [];
  }
}

/**
 * Record outpoints just spent from `address`.
 *
 * ⚠ `INSERT OR IGNORE` DELIBERATELY, AND IT IS NOT MERELY DEFENSIVE. `outpoint`
 * is the primary key, so a re-spend of a key already recorded under a different
 * address is dropped rather than re-attributed. That is the safe direction: an
 * outpoint can only genuinely be spent once, and a row that names the wrong
 * address blacklists nothing for its real owner.
 */
export function recordSpentOutpoints(address: string, keys: string[]): void {
  if (!address || !keys.length) return;
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO spent_outpoints (outpoint, address) VALUES (?, ?)"
    );
    db.transaction(() => {
      for (const k of keys) insert.run(k, address);
    })();
  } catch {
    /* best effort — the caller's in-memory set still protects this process */
  }
}

const store: SpentOutpointStore = {
  load: loadSpentOutpoints,
  add: recordSpentOutpoints,
};

/**
 * Wire the durable store into the browser-shaped transaction builder.
 *
 * ⚠ CALLED AT IMPORT TIME, FROM `wallet.ts`, AND THAT IS THE POINT. It used to
 * be called only from `agent-tick.ts`, which made the fix conditional on an
 * unrelated module happening to be in the route's import graph: any server path
 * that spent without pulling the agent runtime in got the old bug back, silently
 * and with no failing test. `wallet.ts` is imported by `actions.ts` and by every
 * server surface that touches money, so hanging the install there means "the
 * server can spend" and "the blacklist is durable" arrive together.
 *
 * Idempotent.
 */
export function installSpentOutpointStore(): void {
  setSpentOutpointStore(store);
}
