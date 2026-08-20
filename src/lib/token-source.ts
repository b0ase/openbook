import type Database from "better-sqlite3";
import { balanceOf, type TokenBalance } from "@/services/indexer/overlay";
import { db as defaultDb } from "./db";
import { unitsHeld } from "./holdings";

type Db = ReturnType<typeof Database>;

/**
 * Where a balance actually comes from — and saying so out loud.
 *
 * ⚠ THIS MODULE EXISTS TO STOP ONE SENTENCE BEING TOLD. *"You own 3 units of
 * $Occam"* means two completely different things depending on who is
 * guaranteeing it: the network, or a database the operator runs. Today it is
 * mostly the second, and the honest position — the one already published to
 * users — is that balances are provisional until that changes. A number with no
 * provenance attached quietly upgrades itself to the stronger claim, because
 * that is how a reader will take it.
 *
 * So nothing here returns a bare number. Every answer carries where it came
 * from, and the UI is expected to show the difference rather than average it
 * away.
 *
 * ── THE THREE ANSWERS, AND WHY "UNKNOWN" IS NOT ZERO ─────────────────────────
 *
 *  - `chain`    — our overlay read it from Bitcoin. This is the real thing.
 *  - `database` — our ledger says so, and only our ledger. True today for every
 *                 word that has no contract deployed yet.
 *  - `unknown`  — the token IS on chain but we could not read it: never
 *                 whitelisted with the indexer, or the indexer is unreachable.
 *
 * ⚠ THE THIRD MUST NEVER COLLAPSE INTO EITHER OF THE OTHER TWO. Reporting zero
 * locks a paying member out of a room they own; silently falling back to the
 * database reports a chain fact we did not read, which is the exact
 * misrepresentation this file exists to prevent. `unknown` is a real answer and
 * callers have to handle it.
 */

export interface TickerContract {
  symbol: string;
  tokenId: string;
  contractOutpoint: string | null;
  basePrice: number;
  maxSupply: string;
  deployedAt: string;
  whitelistedAt: string | null;
}

export type UnitsAnswer =
  /** Read from Bitcoin via our overlay. Authoritative. */
  | { source: "chain"; units: number; tokenId: string }
  /** Our ledger, and only our ledger — no contract is deployed for this word. */
  | { source: "database"; units: number }
  /** On chain, but unreadable right now. NOT zero, NOT the database figure. */
  | { source: "unknown"; tokenId: string; reason: "not_indexed" | "unreachable" };

interface ContractRow {
  symbol: string;
  token_id: string;
  contract_outpoint: string | null;
  base_price: number;
  max_supply: string;
  deployed_at: string;
  whitelisted_at: string | null;
}

function toContract(r: ContractRow): TickerContract {
  return {
    symbol: r.symbol,
    tokenId: r.token_id,
    contractOutpoint: r.contract_outpoint,
    basePrice: r.base_price,
    maxSupply: r.max_supply,
    deployedAt: r.deployed_at,
    whitelistedAt: r.whitelisted_at,
  };
}

/** The deployed contract for a word, or null if its units are still ours alone. */
export function contractFor(symbol: string, database: Db = defaultDb): TickerContract | null {
  const row = database.prepare("SELECT * FROM ticker_contracts WHERE symbol = ?").get(symbol) as
    | ContractRow
    | undefined;
  return row ? toContract(row) : null;
}

/** Every word whose units are guaranteed by a contract rather than by us. */
export function contractsBySymbol(
  symbols: readonly string[],
  database: Db = defaultDb
): Map<string, TickerContract> {
  const out = new Map<string, TickerContract>();
  const wanted = [...new Set(symbols)].filter(Boolean);
  if (!wanted.length) return out;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(`SELECT * FROM ticker_contracts WHERE symbol IN (${placeholders})`)
    .all(...wanted) as ContractRow[];
  for (const r of rows) out.set(r.symbol, toContract(r));
  return out;
}

/**
 * Record that a word's supply now lives in a contract.
 *
 * ⚠ REFUSES TO OVERWRITE AN EXISTING ROW. A second deploy of the same symbol
 * would strand the first contract's holders: their units are bound to the old
 * token id, and repointing the symbol makes those units invisible while
 * appearing to succeed. If a symbol is already here, that IS its token — a
 * duplicate deploy is a mistake to be investigated, not reconciled.
 */
export function recordContract(
  c: Omit<TickerContract, "deployedAt" | "whitelistedAt">,
  database: Db = defaultDb
): boolean {
  const result = database
    .prepare(
      `INSERT OR IGNORE INTO ticker_contracts
         (symbol, token_id, contract_outpoint, base_price, max_supply)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(c.symbol, c.tokenId, c.contractOutpoint, c.basePrice, c.maxSupply);
  return result.changes > 0;
}

/** Note that our indexer has been asked to watch this token. */
export function markWhitelisted(symbol: string, database: Db = defaultDb): void {
  database
    .prepare(
      "UPDATE ticker_contracts SET whitelisted_at = datetime('now') WHERE symbol = ? AND whitelisted_at IS NULL"
    )
    .run(symbol);
}

/**
 * Turn a contract lookup and an overlay reply into an answer with provenance.
 *
 * Pure, and separated from the request on purpose: this mapping is the whole
 * safety property of the module, and it should be testable without a network or
 * a database.
 */
export function decideSource(
  contract: TickerContract | null,
  chain: TokenBalance | null,
  databaseUnits: number
): UnitsAnswer {
  // No contract: our ledger is not a fallback here, it is the actual and only
  // answer, and it is labelled as such.
  if (!contract) return { source: "database", units: databaseUnits };

  if (!chain) return { source: "unknown", tokenId: contract.tokenId, reason: "unreachable" };

  switch (chain.status) {
    case "ok":
      return { source: "chain", units: chain.units, tokenId: contract.tokenId };
    case "notIndexed":
      // The token is real and its holders exist; this overlay was never told to
      // watch it. Answering with the database figure would dress our record up
      // as a chain reading.
      return { source: "unknown", tokenId: contract.tokenId, reason: "not_indexed" };
    default:
      return { source: "unknown", tokenId: contract.tokenId, reason: "unreachable" };
  }
}

/**
 * How many units of `symbol` this address holds, and who says so.
 *
 * ⚠ THE ADDRESS, NOT THE PUBKEY, IS WHAT THE CHAIN CAN ANSWER. Our ledger keys
 * holdings on a pubkey; the overlay indexes `p2pkh:<address>:<tokenId>`. Both
 * are needed, and passing one where the other belongs silently reads zero.
 */
export async function unitsFor(
  symbol: string,
  pubkey: string | null,
  address: string | null,
  database: Db = defaultDb
): Promise<UnitsAnswer> {
  const contract = contractFor(symbol, database);
  const ledger = unitsHeld(symbol, pubkey, database);
  if (!contract) return { source: "database", units: ledger };
  if (!address) return { source: "unknown", tokenId: contract.tokenId, reason: "unreachable" };
  const chain = await balanceOf(contract.tokenId, address).catch(() => null);
  return decideSource(contract, chain, ledger);
}

/**
 * How far the migration has actually got — the number behind the status page.
 *
 * Deliberately counts CONTRACTS, not posts or holdings: the claim being made is
 * "these words are guaranteed by the network", and only a deployed contract
 * supports it.
 */
export function migrationProgress(database: Db = defaultDb): {
  withContract: number;
  whitelisted: number;
  total: number;
} {
  const withContract = (
    database.prepare("SELECT COUNT(*) AS n FROM ticker_contracts").get() as { n: number }
  ).n;
  const whitelisted = (
    database
      .prepare("SELECT COUNT(*) AS n FROM ticker_contracts WHERE whitelisted_at IS NOT NULL")
      .get() as { n: number }
  ).n;
  const total = (
    database.prepare("SELECT COUNT(DISTINCT symbol) AS n FROM ticker_mentions").get() as {
      n: number;
    }
  ).n;
  return { withContract, whitelisted, total };
}
