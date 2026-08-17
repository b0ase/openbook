/**
 * The two decisions the spent-outpoint blacklist gets wrong quietly.
 *
 * ⚠ WHAT IS BEING PROTECTED. WhatsOnChain keeps reporting an output as unspent
 * for as long as the transaction spending it sits in the mempool. Offer that
 * output to the builder again and it produces a double-spend, which ARC refuses —
 * so a wallet that forgets what it spent cannot spend again until a block lands.
 * The blacklist is the memory. Both functions here decide what stays in it, and
 * both failure modes are silent: nothing throws, a broadcast is simply rejected
 * some time later with a message about a double-spend rather than about a
 * blacklist.
 *
 * Extracted to stand alone for the same reason `isSpendableUtxo` was — the rest of
 * `client-boot.ts` is network I/O over module-level wallet state, and these are
 * not rules to verify by reading them.
 */

import { describe, expect, it } from "vitest";
import { parseSpentStorage, pruneSpentForAddress, UNKNOWN_ADDRESS } from "./client-boot";

const A = "1AaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaA";
const B = "1BbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbB";

describe("parseSpentStorage", () => {
  it("reads the current shape", () => {
    const raw = JSON.stringify([
      ["aa:0", A],
      ["bb:1", B],
    ]);
    const out = parseSpentStorage(raw);
    expect(out.get("aa:0")).toBe(A);
    expect(out.get("bb:1")).toBe(B);
  });

  it("KEEPS a blacklist stored in the old address-less shape", () => {
    // ⚠ The upgrade case, and the one with a real cost attached. Anyone whose
    // browser held `["txid:0", ...]` when this shipped had an unconfirmed spend
    // in flight; dropping their blacklist hands the same UTXO back to the next
    // boost and the broadcast is refused. Migrating is not a nicety.
    const out = parseSpentStorage(JSON.stringify(["aa:0", "bb:1"]));
    expect(out.size).toBe(2);
    expect(out.get("aa:0")).toBe(UNKNOWN_ADDRESS);
  });

  it("reads a mixture, because a browser can be upgraded mid-flight", () => {
    const out = parseSpentStorage(JSON.stringify(["aa:0", ["bb:1", B]]));
    expect(out.get("aa:0")).toBe(UNKNOWN_ADDRESS);
    expect(out.get("bb:1")).toBe(B);
  });

  it("treats absent, malformed and wrong-typed storage as an empty blacklist", () => {
    // An empty blacklist costs a rejected broadcast; a throw here happens during
    // module import and takes down the page. Never the second one.
    expect(parseSpentStorage(null).size).toBe(0);
    expect(parseSpentStorage("").size).toBe(0);
    expect(parseSpentStorage("not json").size).toBe(0);
    expect(parseSpentStorage('{"a":1}').size).toBe(0);
    expect(parseSpentStorage("[1,2,3]").size).toBe(0);
    expect(parseSpentStorage(JSON.stringify([["aa:0", 7]])).get("aa:0")).toBe(UNKNOWN_ADDRESS);
  });
});

describe("pruneSpentForAddress", () => {
  it("drops an entry the chain no longer lists — its spender confirmed", () => {
    const spent = new Map([["aa:0", A]]);
    expect(pruneSpentForAddress(spent, A, new Set())).toBe(true);
    expect(spent.size).toBe(0);
  });

  it("keeps an entry the chain still lists — its spender is in the mempool", () => {
    // This is the whole premise: still listed as unspent means the spend has not
    // confirmed, so the blacklist is the only thing standing between the builder
    // and a double-spend.
    const spent = new Map([["aa:0", A]]);
    expect(pruneSpentForAddress(spent, A, new Set(["aa:0"]))).toBe(false);
    expect(spent.get("aa:0")).toBe(A);
  });

  it("NEVER touches another address's entries", () => {
    // ⚠ The bug this function was extracted to make impossible. One server
    // process spends from the platform wallet AND from every configured agent's
    // key. Unscoped, an agent fetching its own UTXOs pruned every platform
    // outpoint — absent from the agent's response because it was never going to
    // be there — and the next free boost offered a UTXO already spent by a
    // transaction still in the mempool.
    const spent = new Map([
      ["aa:0", A],
      ["bb:1", B],
    ]);
    const changed = pruneSpentForAddress(spent, A, new Set(["aa:0"]));
    expect(changed).toBe(false);
    expect(spent.get("bb:1")).toBe(B);
  });

  it("does not prune B's entry even when fetching B would have pruned it", () => {
    // Same fact from the other side: A's fetch must be incapable of expiring B,
    // whatever A's response contains.
    const spent = new Map([["bb:1", B]]);
    expect(pruneSpentForAddress(spent, A, new Set())).toBe(false);
    expect(spent.get("bb:1")).toBe(B);
  });

  it("leaves address-less entries alone", () => {
    // Migrated from the old storage shape, so unattributable. Keeping one costs
    // an unspendable UTXO until the size cap evicts it. Dropping a live one costs
    // a rejected broadcast. Not symmetric, so prefer the first.
    const spent = new Map([["aa:0", UNKNOWN_ADDRESS]]);
    expect(pruneSpentForAddress(spent, A, new Set())).toBe(false);
    expect(spent.size).toBe(1);
    // ...and not even when the fetch is itself for the empty address, which is
    // what a misconfigured wallet passes in.
    expect(pruneSpentForAddress(spent, UNKNOWN_ADDRESS, new Set())).toBe(false);
    expect(spent.size).toBe(1);
  });

  it("prunes only the confirmed subset of one address's entries", () => {
    const spent = new Map([
      ["aa:0", A],
      ["aa:1", A],
      ["bb:1", B],
    ]);
    expect(pruneSpentForAddress(spent, A, new Set(["aa:1"]))).toBe(true);
    expect([...spent.keys()].sort()).toEqual(["aa:1", "bb:1"]);
  });
});
