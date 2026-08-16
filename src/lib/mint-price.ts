/**
 * What the next unit of a token costs to mint.
 *
 * ⚠ LINEAR, AND THE SLOPE IS THE WHOLE MECHANISM. TOKENS.md settled this on
 * 2026-08-14: *"Cost price for the first, twice cost price for the second, three
 * times for the third — linear, not exponential, otherwise keywords can't
 * realistically be bought and proliferate."* Two things fall out of the slope,
 * and neither survives a flat price:
 *
 *  - **It is how a seat appreciates.** A unit minted at `C` is worth up to the
 *    CURRENT mint price, because that is what it costs anyone to get in without
 *    buying yours. Appreciation therefore tracks how many people actually
 *    joined — real demand, not expectation. At a flat price a second-hand unit
 *    is never worth more than `C` and there is no upside at all.
 *  - **It is a ceiling on resale.** Nobody rationally pays more second-hand than
 *    the price of minting a fresh one, so the market cannot detach upward. The
 *    pump is bounded by arithmetic rather than by anybody policing it.
 *
 * The floor is set by what access is worth to the marginal member, and holders
 * undercutting the curve is the market working: squeezed from the ceiling by the
 * mint price and from the floor by utility. Selling below the curve and above
 * what you paid is the ordinary profit of having been early.
 *
 * ⚠ NOT YET CHARGED. Posting costs a flat price today (`post-economics.ts`), so
 * this is the curve as designed, shown so the market can price a token — it is
 * not what a poster is billed. Wiring it to the actual charge is a money-path
 * change and a separate decision.
 */

/**
 * Cost of the FIRST unit, in satoshis.
 *
 * Set at roughly what a post costs to inscribe, so the first mint is priced at
 * cost and every unit after it carries the slope. Deliberately a constant rather
 * than read from the live fee policy: the market page prices thousands of tokens
 * in one render, and a curve that moved with the fee estimator would make two
 * rows disagree for no reason a reader could see.
 */
export const MINT_BASE_SATS = 113;

/**
 * Price of the next unit, given how many already exist.
 *
 * `unitsMinted` is the CURRENT supply, so the first mint (supply 0) costs
 * `MINT_BASE_SATS` and the Nth costs `N × MINT_BASE_SATS`.
 */
export function mintPriceSats(unitsMinted: number, base = MINT_BASE_SATS): number {
  const n = Number.isFinite(unitsMinted) ? Math.max(0, Math.floor(unitsMinted)) : 0;
  return (n + 1) * base;
}

/**
 * Total cost of minting `count` units from a supply of `unitsMinted`.
 *
 * Linear per unit means the total is quadratic — `C·N(N+1)/2` from zero — which
 * is what makes a name expensive to corner without making the first few units
 * expensive to buy.
 */
export function mintCostForRange(
  unitsMinted: number,
  count: number,
  base = MINT_BASE_SATS
): number {
  const start = Math.max(0, Math.floor(unitsMinted));
  const n = Math.max(0, Math.floor(count));
  let total = 0;
  for (let i = 0; i < n; i++) total += mintPriceSats(start + i, base);
  return total;
}
