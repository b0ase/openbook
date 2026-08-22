import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";

type Db = ReturnType<typeof Database>;

/**
 * The queue of units that are owed on chain but not yet issued.
 *
 * ⚠ THE QUEUE IS A QUERY, NOT A TABLE — the same shape `anchor-sweep.ts` uses
 * for un-anchored posts, and for the same reason: a queue table can disagree
 * with the thing it describes, and this one cannot. A naming is owed its units
 * exactly when it has no `mint_txid` and its word has a deployed covenant.
 * Durable across restarts for free.
 *
 * ⚠ AN UNMINTED ROW IS A DEBT, NOT A DOUBT. The author paid the mint charge
 * when they posted; what is missing is the network having issued the units.
 * Anything that "cleans up" this queue by dropping rows is deleting somebody's
 * paid-for property. Deferral is always correct; dropping never is.
 *
 * ⚠ WORDS WITH NO CONTRACT ARE NOT IN THE QUEUE AND ARE NOT BEHIND. Most words
 * have no covenant deployed, so their units are a ledger entry and honestly
 * labelled `database` by `token-source.ts`. They are not pending — there is
 * nothing to wait for. Counting them as backlog would report a permanent
 * failure of a thing that was never attempted.
 */

export interface PendingMint {
  mentionId: number;
  symbol: string;
  units: number;
  /** The naming author's pubkey — the units are minted to THEIR address. */
  pubkey: string | null;
  postId: number;
  /** The covenant's deploy outpoint: the token's permanent BSV-21 identity. */
  tokenId: string;
  /** Where the covenant lives RIGHT NOW. Moves with every mint. */
  contractOutpoint: string | null;
  /** Its current locking script, hex. Null means we have lost track of it. */
  contractScript: string | null;
  basePrice: number;
  maxSupply: string;
}

interface Row {
  mention_id: number;
  symbol: string;
  units: number;
  pubkey: string | null;
  post_id: number;
  token_id: string;
  contract_outpoint: string | null;
  contract_script: string | null;
  base_price: number;
  max_supply: string;
}

/**
 * Namings still awaiting an on-chain mint, oldest first.
 *
 * ⚠ THE JOIN IS WHAT MAKES THIS THE QUEUE. An INNER JOIN on `ticker_contracts`
 * excludes every word that has no covenant — which is most of them — so the
 * sweep never picks up work it has no way to do.
 *
 * ⚠ AND A ROW WITH NO PUBKEY IS SKIPPED HERE, NOT LATER. Genesis posts carry no
 * key, so their units belong to nobody and there is no address to mint to. A
 * sweep that discovered this per-row would retry them forever, and they would
 * sit at the head of an oldest-first queue blocking everything behind them.
 */
export function pendingMints(limit = 20, database: Db = defaultDb): PendingMint[] {
  const rows = database
    .prepare(
      `SELECT m.id AS mention_id, m.symbol, m.units, m.pubkey, m.post_id,
              c.token_id, c.contract_outpoint, c.contract_script, c.base_price, c.max_supply
         FROM ticker_mentions m
         JOIN ticker_contracts c ON c.symbol = m.symbol
        WHERE m.mint_txid IS NULL
          AND m.pubkey IS NOT NULL AND m.pubkey <> ''
        ORDER BY m.id ASC
        LIMIT ?`
    )
    .all(limit) as Row[];
  return rows.map((r) => ({
    mentionId: r.mention_id,
    symbol: r.symbol,
    units: r.units,
    pubkey: r.pubkey,
    postId: r.post_id,
    tokenId: r.token_id,
    contractOutpoint: r.contract_outpoint,
    contractScript: r.contract_script,
    basePrice: r.base_price,
    maxSupply: r.max_supply,
  }));
}

/**
 * Record a mint that has landed, and move the covenant on — in ONE transaction.
 *
 * ⚠ BOTH WRITES OR NEITHER, AND THE REASON IS NOT TIDINESS. They are two halves
 * of one fact. Recording the mention without advancing the covenant leaves the
 * next sweep building from an outpoint that is already spent — minting for that
 * word halts. Advancing the covenant without recording the mention leaves a
 * naming that has been paid for, has had its units issued on chain, and looks
 * unminted — so the next sweep mints them AGAIN, issuing and charging the
 * treasury twice for one debt. SQLite gives us both-or-neither; take it.
 *
 * ⚠ CALL THIS ONLY AFTER A SUCCESSFUL BROADCAST. Ordering matters and this
 * direction is the safe one: if we crash between the broadcast and this call,
 * the next sweep rebuilds from the stale outpoint and the NETWORK refuses it as
 * a double-spend. That is a halt a chain read can repair. The other order —
 * recording first — would mark a debt paid that may never have reached a miner.
 * **The chain is the lock; the database only remembers.**
 */
export function recordMint(
  args: {
    mentionId: number;
    symbol: string;
    txid: string;
    /** Output index carrying the minted units. */
    vout: number;
    /** The covenant's new outpoint and script, from the continuation we built. */
    nextOutpoint: string;
    nextScript: string;
  },
  database: Db = defaultDb
): boolean {
  const run = database.transaction(() => {
    const updated = database
      .prepare(
        "UPDATE ticker_mentions SET mint_txid = ?, mint_vout = ? WHERE id = ? AND mint_txid IS NULL"
      )
      .run(args.txid, args.vout, args.mentionId);
    // Already recorded by a concurrent sweep — do NOT advance the covenant a
    // second time for the same mint.
    if (updated.changes === 0) return false;
    database
      .prepare(
        "UPDATE ticker_contracts SET contract_outpoint = ?, contract_script = ? WHERE symbol = ?"
      )
      .run(args.nextOutpoint, args.nextScript, args.symbol);
    return true;
  });
  return run();
}

/** How many paid-for namings are still waiting for the network. Observability. */
export function pendingMintCount(database: Db = defaultDb): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n
         FROM ticker_mentions m
         JOIN ticker_contracts c ON c.symbol = m.symbol
        WHERE m.mint_txid IS NULL AND m.pubkey IS NOT NULL AND m.pubkey <> ''`
    )
    .get() as { n: number };
  return row.n;
}
