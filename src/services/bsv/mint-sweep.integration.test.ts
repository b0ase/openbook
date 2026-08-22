/**
 * Draining the mint queue.
 *
 * ⚠ THE FAILURES THAT MATTER HERE ARE BOTH FINANCIAL, AND THEY POINT OPPOSITE
 * WAYS. Minting a naming TWICE issues units nobody paid for and pays the miner
 * twice; dropping one takes an author's money and never delivers. Almost every
 * test below is one of those two, and the happy path exists mainly to prove the
 * others are reachable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pendingMintCount, pendingMints, recordMint } from "@/lib/mint-queue";
import { recordContract } from "@/lib/token-source";
import {
  __resetMintSweepState,
  type MintExecutor,
  type MintOutcome,
  minterAddressFor,
  sweepMints,
} from "./mint-sweep";

const SYMBOL = "$OCCAM";
const OTHER = "$UNDEPLOYED";
const PUBKEY = "02".padEnd(66, "a");
const SCRIPT = "5253";
const OUTPOINT = `${"cd".repeat(32)}_0`;

function makePost(pubkey: string | null): number {
  return db
    .prepare("INSERT INTO posts (content, author_name, pubkey) VALUES (?, 'anon_x', ?)")
    .run("naming a word", pubkey).lastInsertRowid as number;
}

function makeMention(symbol: string, pubkey: string | null): number {
  const postId = makePost(pubkey);
  return db
    .prepare(
      `INSERT INTO ticker_mentions (symbol, post_id, pubkey, target_type) VALUES (?, ?, ?, 'none')`
    )
    .run(symbol, postId, pubkey).lastInsertRowid as number;
}

function deployContract(symbol: string, script: string | null = SCRIPT): void {
  recordContract({
    symbol,
    tokenId: `${"ab".repeat(32)}_0`,
    contractOutpoint: OUTPOINT,
    basePrice: 113,
    maxSupply: "21000000",
  });
  db.prepare("UPDATE ticker_contracts SET contract_script = ? WHERE symbol = ?").run(
    script,
    symbol
  );
}

const minted = (over: Partial<MintOutcome> = {}): MintOutcome =>
  ({
    status: "minted",
    txid: "ef".repeat(32),
    vout: 1,
    nextOutpoint: `${"ef".repeat(32)}_0`,
    nextScript: "5354",
    feeSats: 5300,
    ...over,
  }) as MintOutcome;

beforeEach(() => {
  db.exec("DELETE FROM ticker_mentions; DELETE FROM ticker_contracts; DELETE FROM posts");
  __resetMintSweepState();
});

describe("the queue", () => {
  it("holds namings whose word has a deployed covenant", () => {
    deployContract(SYMBOL);
    const id = makeMention(SYMBOL, PUBKEY);
    const q = pendingMints(10, db);
    expect(q).toHaveLength(1);
    expect(q[0].mentionId).toBe(id);
    expect(q[0].contractScript).toBe(SCRIPT);
  });

  /**
   * ⚠ A WORD WITH NO COVENANT IS NOT BEHIND — IT WAS NEVER STARTED. Most words
   * are in this state, honestly labelled `database` by `token-source.ts`.
   * Counting them as pending would report a permanent backlog of work that does
   * not exist and bury the rows that really are waiting.
   */
  it("EXCLUDES words with no covenant deployed", () => {
    makeMention(OTHER, PUBKEY);
    expect(pendingMints(10, db)).toHaveLength(0);
    expect(pendingMintCount(db)).toBe(0);
  });

  /**
   * ⚠ AND IT EXCLUDES THEM AT THE QUERY, NOT PER ROW. Genesis posts carry no
   * key, so their units belong to nobody and there is no address to mint to. In
   * an oldest-first queue they sit at the head — discovering this per row would
   * let them block every naming behind them forever.
   */
  it("EXCLUDES namings with no key to mint to", () => {
    deployContract(SYMBOL);
    makeMention(SYMBOL, null);
    makeMention(SYMBOL, "");
    expect(pendingMints(10, db)).toHaveLength(0);
  });

  it("drops a naming out of the queue once it is minted", () => {
    deployContract(SYMBOL);
    const id = makeMention(SYMBOL, PUBKEY);
    recordMint(
      {
        mentionId: id,
        symbol: SYMBOL,
        txid: "aa".repeat(32),
        vout: 1,
        nextOutpoint: "x_0",
        nextScript: "55",
      },
      db
    );
    expect(pendingMints(10, db)).toHaveLength(0);
  });
});

describe("recordMint", () => {
  it("advances the covenant and records the mint together", () => {
    deployContract(SYMBOL);
    const id = makeMention(SYMBOL, PUBKEY);
    expect(
      recordMint(
        {
          mentionId: id,
          symbol: SYMBOL,
          txid: "bb".repeat(32),
          vout: 1,
          nextOutpoint: "new_0",
          nextScript: "56",
        },
        db
      )
    ).toBe(true);
    const row = db
      .prepare("SELECT contract_outpoint, contract_script FROM ticker_contracts WHERE symbol = ?")
      .get(SYMBOL) as { contract_outpoint: string; contract_script: string };
    expect(row.contract_outpoint).toBe("new_0");
    expect(row.contract_script).toBe("56");
  });

  /**
   * ⚠ THE DOUBLE-MINT GUARD. Two sweeps racing the same row must not advance the
   * covenant twice: the second advance would point at an outpoint no mint ever
   * created, halting the word, while the first mint's units were already issued.
   * The UPDATE is conditional on the row still being unminted, so the loser is a
   * no-op rather than a second write.
   */
  it("REFUSES a second record for the same naming, and does not move the covenant", () => {
    deployContract(SYMBOL);
    const id = makeMention(SYMBOL, PUBKEY);
    recordMint(
      {
        mentionId: id,
        symbol: SYMBOL,
        txid: "cc".repeat(32),
        vout: 1,
        nextOutpoint: "first_0",
        nextScript: "57",
      },
      db
    );
    expect(
      recordMint(
        {
          mentionId: id,
          symbol: SYMBOL,
          txid: "dd".repeat(32),
          vout: 1,
          nextOutpoint: "second_0",
          nextScript: "58",
        },
        db
      )
    ).toBe(false);
    const row = db
      .prepare("SELECT contract_outpoint FROM ticker_contracts WHERE symbol = ?")
      .get(SYMBOL) as { contract_outpoint: string };
    expect(row.contract_outpoint).toBe("first_0");
  });
});

describe("the sweep", () => {
  it("mints one naming and records where it landed", async () => {
    deployContract(SYMBOL);
    const id = makeMention(SYMBOL, PUBKEY);
    const execute: MintExecutor = vi.fn(async () => minted());

    const result = await sweepMints(execute, db);
    expect(result).toEqual({ swept: 1, outcome: "minted" });
    expect(execute).toHaveBeenCalledTimes(1);
    const row = db
      .prepare("SELECT mint_txid, mint_vout FROM ticker_mentions WHERE id = ?")
      .get(id) as {
      mint_txid: string;
      mint_vout: number;
    };
    expect(row.mint_txid).toBe("ef".repeat(32));
    expect(row.mint_vout).toBe(1);
  });

  it("mints the OLDEST naming first, one per tick", async () => {
    deployContract(SYMBOL);
    const first = makeMention(SYMBOL, PUBKEY);
    makeMention(SYMBOL, PUBKEY);
    const seen: number[] = [];
    const execute: MintExecutor = async (job) => {
      seen.push(job.mentionId);
      return minted({ txid: `${job.mentionId}`.padStart(64, "0") } as Partial<MintOutcome>);
    };
    await sweepMints(execute, db);
    expect(seen).toEqual([first]);
    expect(pendingMintCount(db)).toBe(1);
  });

  it("passes the address derived from the naming author's own key", async () => {
    deployContract(SYMBOL);
    const real = "02b4632d08485ff1df2db55b9dafd23347d1c47a457072a1e87be26896549a8737";
    makeMention(SYMBOL, real);
    let got: string | undefined;
    await sweepMints(async (job) => {
      got = job.minterAddress;
      return minted();
    }, db);
    expect(got).toBe(await minterAddressFor(real));
    expect(got).toBeTruthy();
  });

  /**
   * ⚠ DEFERRAL MUST LEAVE THE DEBT INTACT. A dry wallet or a dead broadcaster is
   * "later", never "never" — the author has already paid for these units.
   */
  it("leaves a deferred naming in the queue, unrecorded", async () => {
    deployContract(SYMBOL);
    makeMention(SYMBOL, PUBKEY);
    const result = await sweepMints(async () => ({ status: "deferred", reason: "dry wallet" }), db);
    expect(result.outcome).toBe("deferred");
    expect(pendingMintCount(db)).toBe(1);
  });

  it("leaves a FAILED naming in the queue too — a failure is not a forfeit", async () => {
    deployContract(SYMBOL);
    makeMention(SYMBOL, PUBKEY);
    await sweepMints(async () => ({ status: "failed", reason: "rejected" }), db);
    expect(pendingMintCount(db)).toBe(1);
  });

  it("backs a failed naming off rather than hammering it", async () => {
    deployContract(SYMBOL);
    makeMention(SYMBOL, PUBKEY);
    const execute = vi.fn(async () => ({ status: "deferred", reason: "x" }) as MintOutcome);
    await sweepMints(execute, db);
    await sweepMints(execute, db);
    // The second tick finds the row still backing off and does no work.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips a word whose covenant script we have lost track of", async () => {
    deployContract(SYMBOL, null);
    makeMention(SYMBOL, PUBKEY);
    const execute = vi.fn(async () => minted());
    const result = await sweepMints(execute, db);
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome).toBe("skipped");
    expect(pendingMintCount(db)).toBe(1);
  });

  it("does nothing when there is nothing owed", async () => {
    const execute = vi.fn(async () => minted());
    await sweepMints(execute, db);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("minterAddressFor", () => {
  it("refuses a key it cannot parse rather than inventing an address", async () => {
    expect(await minterAddressFor("not-a-key")).toBeNull();
    expect(await minterAddressFor("")).toBeNull();
  });
});
