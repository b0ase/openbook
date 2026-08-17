/**
 * The durable spent-outpoint ledger, against a real database.
 *
 * ⚠ WHAT BREAKS WITHOUT THIS TABLE. WhatsOnChain reports an output as unspent for
 * as long as the transaction spending it sits in the mempool, so a wallet has to
 * remember what it spent. A browser remembers in localStorage. A server has no
 * localStorage, so its memory was process-local and every deploy erased it — and
 * the next broadcast reused an output already spent, which ARC refuses. That is
 * how the agent runtime failed on its first live run.
 *
 * ⚠ AND WHAT BREAKS WITH THE TABLE BUT WITHOUT ADDRESSES. Both consumers prune by
 * fetching one address's UTXO set and dropping blacklisted outpoints the response
 * no longer lists. That inference is only valid for that address. One server
 * process spends from the platform wallet and from every configured agent's key,
 * so an unscoped ledger is one where hydration pulls every address's outpoints
 * into a single set for the next fetch to throw away.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { loadSpentOutpoints, recordSpentOutpoints } from "@/lib/spent-outpoints";

const A = "1AaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaA";
const B = "1BbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbB";

beforeEach(() => {
  db.exec("DELETE FROM spent_outpoints");
});

describe("the durable spent-outpoint ledger", () => {
  it("survives the process that wrote it", () => {
    // The point of the table: `loadSpentOutpoints` is what a FRESH process calls,
    // and it must see what the previous one spent.
    recordSpentOutpoints(A, ["aa:0", "aa:1"]);
    expect(loadSpentOutpoints(A).sort()).toEqual(["aa:0", "aa:1"]);
  });

  it("NEVER returns another address's outpoints", () => {
    // ⚠ The reason the address column exists. Hydrating B's outpoints into the
    // platform wallet's blacklist means the next platform fetch prunes them all —
    // absent from its response because they were never going to be there — and
    // A's real protection goes with them.
    recordSpentOutpoints(A, ["aa:0"]);
    recordSpentOutpoints(B, ["bb:0"]);
    expect(loadSpentOutpoints(A)).toEqual(["aa:0"]);
    expect(loadSpentOutpoints(B)).toEqual(["bb:0"]);
  });

  it("is idempotent — a re-recorded spend does not duplicate", () => {
    recordSpentOutpoints(A, ["aa:0"]);
    recordSpentOutpoints(A, ["aa:0", "aa:1"]);
    expect(loadSpentOutpoints(A).sort()).toEqual(["aa:0", "aa:1"]);
  });

  it("prunes rows old enough that their spender has certainly confirmed", () => {
    // Pruning happens on READ, because that is the only moment we are certainly
    // on a server with the table open. The set only has to outlive a mempool.
    recordSpentOutpoints(A, ["old:0", "new:0"]);
    db.prepare(
      "UPDATE spent_outpoints SET spent_at = datetime('now', '-4 days') WHERE outpoint = ?"
    ).run("old:0");
    expect(loadSpentOutpoints(A)).toEqual(["new:0"]);
    // Gone from the table, not merely filtered out of the answer.
    const rows = db.prepare("SELECT outpoint FROM spent_outpoints").all() as Array<{
      outpoint: string;
    }>;
    expect(rows.map((r) => r.outpoint)).toEqual(["new:0"]);
  });

  it("keeps a row that is old but not yet past the window", () => {
    recordSpentOutpoints(A, ["aa:0"]);
    db.prepare("UPDATE spent_outpoints SET spent_at = datetime('now', '-2 days')").run();
    expect(loadSpentOutpoints(A)).toEqual(["aa:0"]);
  });

  it("does nothing, rather than throwing, when there is no address", () => {
    // A wallet with no key configured. Refusing to record is right; throwing would
    // turn a missing env var into a crash on the money path.
    expect(() => recordSpentOutpoints("", ["aa:0"])).not.toThrow();
    expect(loadSpentOutpoints("")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spent_outpoints").get()).toEqual({ n: 0 });
  });

  it("does nothing when given no outpoints", () => {
    expect(() => recordSpentOutpoints(A, [])).not.toThrow();
    expect(loadSpentOutpoints(A)).toEqual([]);
  });

  it("attributes a row written before addresses were tracked to no address", () => {
    // The pre-migration rows in production. They cannot be attributed after the
    // fact, so they belong to nobody and age out — never silently to whichever
    // wallet asks first, which would blacklist another address's money.
    db.prepare("INSERT INTO spent_outpoints (outpoint) VALUES (?)").run("legacy:0");
    expect(loadSpentOutpoints(A)).toEqual([]);
    expect(loadSpentOutpoints(B)).toEqual([]);
  });
});

describe("the store is installed without anyone remembering to", () => {
  it("is registered into the builder merely by importing the server wallet", async () => {
    // ⚠ THE REGRESSION THIS EXISTS TO CATCH. `installSpentOutpointStore()` was
    // called only from `agent-tick.ts`, so durability depended on the agent
    // runtime happening to be in a route's import graph. Any server path that
    // spent without pulling it in got the old bug back, with nothing failing
    // anywhere. It now hangs off `wallet.ts`, which every server surface that
    // touches money already reaches — and this asserts that, so moving it
    // somewhere less travelled breaks a test rather than production.
    const { hasSpentOutpointStore } = await import("@/services/bsv/client-boot");
    await import("@/services/bsv/wallet");
    expect(hasSpentOutpointStore()).toBe(true);
  });

  it("reaches the builder through the ordinary server-action import too", async () => {
    // `actions.ts` is what the app actually calls. If it stops reaching the
    // wallet, the builder loses its durable blacklist silently — so assert the
    // path rather than trusting today's import graph.
    const { hasSpentOutpointStore } = await import("@/services/bsv/client-boot");
    await import("@/app/actions");
    expect(hasSpentOutpointStore()).toBe(true);
  });
});
