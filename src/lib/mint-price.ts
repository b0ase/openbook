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
 * ⚠ THIS IS CHARGED (owner, 2026-08-16: *"do the curve"*). `mint-charge.ts`
 * turns it into satoshis against live supply, `payForPost` funds it, and
 * `createPost` verifies it against a tolerance band. This file stays PURE — no
 * database, no config — so the client, the server and the market page all
 * price a token by the same arithmetic.
 */

/**
 * Cost of the FIRST unit, in satoshis.
 *
 * Set at roughly what a post costs to inscribe, so the first mint is priced at
 * cost and every unit after it carries the slope. Deliberately a constant rather
 * than read from the live fee policy: the market page prices thousands of tokens
 * in one render, and a curve that moved with the fee estimator would make two
 * rows disagree for no reason a reader could see.
 *
 * ⚠ "PRICED AT COST" STOPS BEING TRUE ONCE A COVENANT IS IN THE PATH, and the
 * gap is not small. Measured 2026-08-20 by building a real mint spend
 * (`contracts/scripts/dump-mint.ts`): the pay-to-mint contract's locking script
 * is ~24KB, and a spend carries it TWICE — once as the output it re-creates,
 * once inside the sighash preimage. So a mint transaction is **48,438 bytes and
 * costs ~5,329 satoshis** at the app's 110 sat/kB, against a first-unit price of
 * 113. **The network fee is roughly 47x the token being bought**, and it does
 * not shrink with the number of units taken.
 *
 * ⚠ SO THE CURVE IS FLAT WHERE IT LOOKS STEEPEST. Below about unit 47 the fee
 * dominates so completely that the first unit and the fortieth cost a minter
 * almost the same. The "cost price for the first, twice for the second" mechanic
 * only starts to bite above that. Long-run appreciation is unaffected; the early
 * slope is mostly theatre.
 *
 * ⚠ THE OWNER'S CALL (2026-08-20) IS TO LEAVE IT: *"leave it"* — in dollars the
 * whole mint is under a tenth of a penny, and redesigning the economics around
 * a sub-penny is not worth it. This is documented rather than fixed. Revisit if
 * a word ever gets popular enough for the flat early range to matter, or if the
 * covenant can be made smaller. Do NOT quietly raise this constant to "cover
 * the fee" — the fee is not a mint price, and burying it here would make the
 * number mean two things at once.
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

/**
 * What a post owes for the units it mints.
 *
 * ⚠ ONE UNIT PER TICKER PER POST, so the price is the SUM of each named word's
 * next-unit price — not the highest, and not one price for the post. That
 * follows from the schema rather than being a choice: `ticker_mentions` carries a
 * partial unique index on `(post_id, symbol)`, so naming `$A` twice in one post
 * mints one unit of `$A`, and naming `$A` and `$B` mints one of each. Charging a
 * single price for a post that mints three units would let someone acquire the
 * expensive words by burying them in a post about a cheap one.
 *
 * A post naming NO ticker mints nothing and owes nothing here — its cost is the
 * ordinary inscription cost from `post-economics.ts`, which this does not
 * replace but adds to.
 *
 * Pure, so the client that builds the transaction and the server that verifies it
 * can reach the same number from the same inputs. They must: if they disagree the
 * post is either rejected after the author has already broadcast, or accepted
 * underpaid.
 */
export function quoteMintSats(
  symbols: readonly string[],
  supplyOf: (symbol: string) => number,
  base = MINT_BASE_SATS
): number {
  // De-duplicated for the reason above: the schema mints one unit per symbol per
  // post however many times it appears in the text.
  const unique = [...new Set(symbols)];
  return unique.reduce((total, sym) => total + mintPriceSats(supplyOf(sym), base), 0);
}
