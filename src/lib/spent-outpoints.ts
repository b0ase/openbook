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
 * ⚠ REGISTERED, NOT IMPORTED BY THE BUILDER. `client-boot.ts` is shipped to
 * browsers, and importing this module from it would drag `better-sqlite3` — a
 * native module — into the client bundle. The dependency therefore points this
 * way only: the server hands the builder a store, and the builder never learns
 * what a database is.
 */

/** Older than this and the spending transaction has certainly confirmed. */
const PRUNE_AFTER = "-3 days";

const store: SpentOutpointStore = {
  load(): string[] {
    try {
      // Prune on read: it is the only moment we are certainly on a server, in a
      // request, with the table open — and the set only has to be big enough to
      // outlive a mempool, not to be a permanent record.
      db.prepare(`DELETE FROM spent_outpoints WHERE spent_at < datetime('now', ?)`).run(
        PRUNE_AFTER
      );
      const rows = db.prepare("SELECT outpoint FROM spent_outpoints").all() as Array<{
        outpoint: string;
      }>;
      return rows.map((r) => r.outpoint);
    } catch {
      // An empty blacklist costs a rejected broadcast, not money — never let a
      // storage problem take down the thing that was trying to post.
      return [];
    }
  },

  add(keys: string[]): void {
    if (!keys.length) return;
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO spent_outpoints (outpoint) VALUES (?)");
      db.transaction(() => {
        for (const k of keys) insert.run(k);
      })();
    } catch {
      /* best effort — the in-memory set still protects this process */
    }
  },
};

/**
 * Wire the durable store into the transaction builder.
 *
 * Idempotent, and called from server-only modules at import time so the store is
 * present before anything tries to select a UTXO.
 */
export function installSpentOutpointStore(): void {
  setSpentOutpointStore(store);
}
