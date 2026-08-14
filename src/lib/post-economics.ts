/**
 * What a post costs to mint, and what the platform takes for minting it.
 *
 * Pricing is **FLAT COST-PLUS**, settled by the owner (DECISIONS.md — *a token
 * is a RECEIPT*): sell at cost plus a markup nobody notices, and make the
 * business out of volume rather than scarcity. This supersedes the linear mint
 * curve, which existed to make a holder's share defensible — a receipt does not
 * need defending.
 *
 * ⚠ THE PRICE DOES NOT RISE WITH SUPPLY, AND THAT IS DELIBERATE. It removes the
 * usual pump dynamic by construction: nobody rationally pays more second-hand
 * than a fresh mint costs, and a price that never rises is a ceiling that never
 * rises either.
 */

/**
 * The smallest output worth creating, in satoshis.
 *
 * ⚠ NOT THE DUST LIMIT. The binding floor is that **spending a UTXO costs more
 * than a tiny UTXO is worth**: a P2PKH input is ~148 bytes, so at any realistic
 * fee rate an output below ~10 sats can never be economically claimed by
 * whoever receives it. Paying someone 1 satoshi is worse than paying them
 * nothing — it hands them a UTXO that costs more to move than it contains.
 *
 * Shared deliberately: the payment split (top 100 holders — DECISIONS.md) has to
 * use the SAME floor, or the wallet would advertise a share that no transaction
 * can actually pay out.
 */
export const MIN_ECONOMIC_OUTPUT_SATS = 10;

/**
 * Miner fee rate. Matches `wallet.ts`: the ARC floor is 100 sat/kB and 110 gives
 * rounding headroom (0 rejections observed at 110, occasional at 100).
 */
export const FEE_RATE_SATS_PER_KB = 110;

/** The satoshi the inscription itself carries. */
export const INSCRIPTION_SATS = 1;

export interface PostPrice {
  /** Goes to miners. */
  networkFeeSats: number;
  /** Rides on the inscription output, owned by the author. */
  inscriptionSats: number;
  /** The markup — this is the platform's revenue, and the only part that is ours. */
  platformFeeSats: number;
  /** What the author pays in total. */
  totalSats: number;
  /**
   * True when the markup was raised to `MIN_ECONOMIC_OUTPUT_SATS` because the
   * percentage alone produced an unpayable amount. Surfaced rather than hidden:
   * it means the EFFECTIVE markup is higher than the configured one, which the
   * operator should be able to see rather than infer.
   */
  floored: boolean;
}

function markupPercent(): number {
  // ⚠ CHECK FOR EMPTY BEFORE CONVERTING. `Number("")` is 0, not NaN — so an
  // env var that is present but blank (trivially easy to produce in a hosting
  // dashboard) would read as a 0% markup and silently switch off ALL revenue,
  // looking exactly like a deliberate at-cost setting.
  const raw = (process.env.POST_MARKUP_PERCENT ?? "").trim();
  if (raw === "") return 10;
  const pct = Number(raw);
  // Default 10% — the owner's worked example: "If it cost 1p to mint, we sell it
  // for 1.1p." An explicit zero is legal and means at-cost.
  if (!Number.isFinite(pct) || pct < 0) return 10;
  return pct;
}

/**
 * Price a post of a given serialized size.
 *
 * `sizeBytes` is the size of the whole transaction, not the payload — the miner
 * charges for the transaction, and pricing only the content would under-collect
 * on every post and leave the operator funding the difference.
 */
export function postPrice(sizeBytes: number, opts?: { markupPercent?: number }): PostPrice {
  // Non-finite in means non-finite out: Math.ceil(NaN) is NaN and Math.max
  // propagates it, so a junk size would quote a NaN price and carry it into a
  // transaction builder. Clamp before any arithmetic.
  const bytes = Number.isFinite(sizeBytes) ? Math.max(0, Math.ceil(sizeBytes)) : 0;
  const networkFeeSats = Math.ceil((bytes * FEE_RATE_SATS_PER_KB) / 1000);

  const requested = opts?.markupPercent;
  const pct =
    requested !== undefined && Number.isFinite(requested) && requested >= 0
      ? requested
      : markupPercent();
  // The markup is taken on the cost we actually incur (the miner fee plus the
  // satoshi we hand the author), not on an invented notional price.
  const cost = networkFeeSats + INSCRIPTION_SATS;
  const rawMarkup = Math.ceil((cost * pct) / 100);

  // ⚠ A percentage of a fraction of a penny rounds to something unpayable. When
  // that happens the floor binds, and the effective markup is higher than the
  // configured one — `floored` says so rather than leaving it to be discovered.
  const floored = pct > 0 && rawMarkup < MIN_ECONOMIC_OUTPUT_SATS;
  const platformFeeSats = pct === 0 ? 0 : Math.max(rawMarkup, MIN_ECONOMIC_OUTPUT_SATS);

  return {
    networkFeeSats,
    inscriptionSats: INSCRIPTION_SATS,
    platformFeeSats,
    totalSats: networkFeeSats + INSCRIPTION_SATS + platformFeeSats,
    floored,
  };
}

/**
 * Whether paid posting is switched on.
 *
 * ⚠ DEFAULT OFF, AND IT MUST STAY THAT WAY UNTIL AN INSCRIPTION HAS BEEN SEEN BY
 * A REAL INDEXER. The envelope in `services/bsv/inscription.ts` follows the 1Sat
 * convention and is unit-tested for shape, but shape is not recognition — until
 * one is broadcast and confirmed, turning this on would charge users for tokens
 * that might not be indexed as tokens.
 *
 * Off = the existing free, server-funded OP_RETURN anchoring path, unchanged.
 */
export function isPaidPostingEnabled(): boolean {
  const v = (process.env.PAID_POSTING ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}
