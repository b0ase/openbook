/**
 * Names that must not be claimable on the board.
 *
 * ⚠ `OPENBOOK` NAMES A DIFFERENT ASSET. It was this board's own pre-plural name
 * until 2026-08-14, and is now the repository token for
 * github.com/b0ase/openbook — a fixed supply held by an issuer, not one unit per
 * post held by whoever wrote it. Retiring it as a root spelling freed the string
 * for anyone to claim here, which would have put the two one click apart under
 * one name; the reservation is what closes that.
 *
 * Tested at the MIGRATION rather than through `createPost`, deliberately: the
 * integration suite clears `reserved_tickers` in `beforeEach`, so a test there
 * would prove the seed survives a delete rather than that it is applied at boot.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyReservedTickerMigration } from "./db";
import { isRootTicker } from "./ticker";

type Db = ReturnType<typeof Database>;
let db: Db;

const reserved = () =>
  db.prepare("SELECT symbol, reason FROM reserved_tickers ORDER BY symbol").all() as {
    symbol: string;
    reason: string;
  }[];

beforeEach(() => {
  db = new Database(":memory:");
});

describe("applyReservedTickerMigration", () => {
  it("reserves OPENBOOK at boot, with the reason recorded", () => {
    applyReservedTickerMigration(db);
    expect(reserved()).toEqual([{ symbol: "OPENBOOK", reason: "repo-token" }]);
  });

  it("is idempotent — re-running does not duplicate or re-stamp it", () => {
    applyReservedTickerMigration(db);
    const first = reserved();
    applyReservedTickerMigration(db);
    applyReservedTickerMigration(db);
    expect(reserved()).toEqual(first);
  });

  it("does not disturb a reservation an operator added", () => {
    applyReservedTickerMigration(db);
    db.prepare("INSERT INTO reserved_tickers (symbol, reason) VALUES ('WATER', 'namespace')").run();
    applyReservedTickerMigration(db);
    expect(reserved().map((r) => r.symbol)).toEqual(["OPENBOOK", "WATER"]);
  });

  it("does not reserve the CURRENT root", () => {
    // ⚠ The root is claimable like any other name — it is the board's own token
    // and its units are posts. Reserving it would stop anyone naming the board
    // in a post, which is the opposite of what this board is for.
    applyReservedTickerMigration(db);
    expect(reserved().some((r) => isRootTicker(r.symbol))).toBe(false);
  });
});
