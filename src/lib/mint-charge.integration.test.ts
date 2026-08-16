/**
 * What a post is charged for the tokens it mints.
 *
 * This is the money path, so the tests are written from the two directions it
 * can hurt somebody: charging for words the post does not mint, and accepting a
 * transaction that minted words it did not pay for.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { MINT_SLACK_UNITS, mintChargeSats, mintFloorSats, mintSupplies } from "./mint-charge";
import { MINT_BASE_SATS } from "./mint-price";

/**
 * Mint `n` units of a symbol, the way `recordTickerMentions` does.
 *
 * Real posts, not synthetic ids: `ticker_mentions.post_id` carries a foreign key
 * to `posts`, and a mention that points at no post is not a unit anybody could
 * hold.
 */
function mint(symbol: string, n: number) {
  const newPost = db.prepare(
    "INSERT INTO posts (content, author_name, pubkey) VALUES (?, 'anon_mint', 'pk_test')"
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ticker_mentions (symbol, post_id, pubkey, target_type)
     VALUES (?, ?, ?, 'none')`
  );
  for (let i = 0; i < n; i++) {
    const id = newPost.run(`minting $${symbol}`).lastInsertRowid as number;
    insert.run(symbol, id, "pk_test");
  }
}

beforeEach(() => {
  db.exec("DELETE FROM ticker_mentions");
  db.exec("DELETE FROM posts");
});

describe("mintSupplies", () => {
  it("counts units per symbol in one query", () => {
    mint("ALPHA", 3);
    mint("BETA", 1);
    const supply = mintSupplies(["ALPHA", "BETA", "GAMMA"]);
    expect(supply.get("ALPHA")).toBe(3);
    expect(supply.get("BETA")).toBe(1);
    // A word nobody has named is absent rather than zero — callers default it.
    expect(supply.get("GAMMA")).toBeUndefined();
  });
});

describe("mintChargeSats", () => {
  it("is nothing for a post that names no ticker", () => {
    expect(mintChargeSats("just talking about nothing in particular")).toBe(0);
  });

  it("charges base for a word nobody has named", () => {
    expect(mintChargeSats("starting $Fresh here")).toBe(MINT_BASE_SATS);
  });

  it("rises with supply — the whole mechanism", () => {
    mint("HOT", 4);
    expect(mintChargeSats("citing $Hot")).toBe(5 * MINT_BASE_SATS);
  });

  it("SUMS over distinct words, so an expensive one cannot ride along on a cheap one", () => {
    mint("HOT", 9);
    expect(mintChargeSats("$Hot and $Cold")).toBe(10 * MINT_BASE_SATS + MINT_BASE_SATS);
  });

  it("charges once for a word named twice — one unit is minted, so one is billed", () => {
    expect(mintChargeSats("$Echo $Echo $Echo")).toBe(MINT_BASE_SATS);
  });

  it("is case-insensitive, because the claim is", () => {
    mint("SAME", 2);
    expect(mintChargeSats("$same")).toBe(mintChargeSats("$SAME"));
    expect(mintChargeSats("$Same")).toBe(3 * MINT_BASE_SATS);
  });

  it("does NOT charge for a price — `$50` is not a ticker", () => {
    expect(mintChargeSats("it cost $50 and US$20")).toBe(0);
  });

  it("prices EVERY word, not the first few — a cap here would mint units nobody paid for", () => {
    const many = Array.from({ length: 14 }, (_, i) => `$Word${i}`).join(" ");
    expect(mintChargeSats(many)).toBe(14 * MINT_BASE_SATS);
  });
});

describe("mintFloorSats", () => {
  it("forgives up to the slack, so a quote that went stale still clears", () => {
    mint("DRIFT", MINT_SLACK_UNITS + 2);
    // Charged at the current supply…
    expect(mintChargeSats("$Drift")).toBe((MINT_SLACK_UNITS + 3) * MINT_BASE_SATS);
    // …but accepted down to the price of five units ago.
    expect(mintFloorSats("$Drift")).toBe(3 * MINT_BASE_SATS);
  });

  it("never goes below base, however new the word", () => {
    expect(mintFloorSats("$Brandnew")).toBe(MINT_BASE_SATS);
    mint("ALMOST", 2);
    expect(mintFloorSats("$Almost")).toBe(MINT_BASE_SATS);
  });

  it("is never above the charge — a floor that exceeded the price would reject every honest post", () => {
    mint("A", 7);
    mint("B", 1);
    const content = "$A meets $B and $C";
    expect(mintFloorSats(content)).toBeLessThanOrEqual(mintChargeSats(content));
  });

  it("is nothing when no ticker is named", () => {
    expect(mintFloorSats("nothing named here")).toBe(0);
  });
});
