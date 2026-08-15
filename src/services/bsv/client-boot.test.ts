/**
 * Which UTXOs the wallet is allowed to spend.
 *
 * ⚠ This is the rule that stops the wallet spending the user's own post-tokens.
 * Under paid posting every post mints an inscription locked to the author's own
 * address at 1 satoshi, in the same wallet as their money — and `selectUtxos`
 * sorts smallest-first ON PURPOSE, to sweep up dust. Without this filter an
 * author's ordinals are the FIRST inputs picked for their next boost, and are
 * burned as fee. On a board whose proposition is "own what you post", that is
 * the worst bug available.
 *
 * The rest of `client-boot.ts` is untested (network I/O and module-level wallet
 * state), which is exactly why this predicate was pulled out to stand alone.
 */

import { describe, expect, it } from "vitest";
import { isSpendableUtxo } from "./client-boot";
import { INSCRIPTION_SATS } from "./inscription";

describe("isSpendableUtxo", () => {
  it("REFUSES an inscription-sized output", () => {
    expect(isSpendableUtxo(INSCRIPTION_SATS)).toBe(false);
    expect(isSpendableUtxo(1)).toBe(false);
  });

  it("refuses a zero-value output", () => {
    // Not an ordinal, but nothing to spend either, and including it only buys an
    // input's worth of fee.
    expect(isSpendableUtxo(0)).toBe(false);
  });

  it("allows anything larger", () => {
    // ⚠ The floor is deliberately at 1, not at some economic dust threshold. A
    // 2-satoshi output is uneconomic to spend but it is NOT somebody's token,
    // and quietly stranding real money is a different bug from the one this
    // exists to prevent.
    expect(isSpendableUtxo(2)).toBe(true);
    expect(isSpendableUtxo(546)).toBe(true);
    expect(isSpendableUtxo(658_564)).toBe(true);
  });

  it("keeps the boundary tied to what the app actually mints", () => {
    // If INSCRIPTION_SATS ever changes, the filter has to move with it — the
    // number here is not independently chosen.
    expect(isSpendableUtxo(INSCRIPTION_SATS)).toBe(false);
    expect(isSpendableUtxo(INSCRIPTION_SATS + 1)).toBe(true);
  });
});
