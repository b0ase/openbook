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
 * Fallback miner fee rate, used when the live policy cannot be read. Matches
 * `wallet.ts`: the ARC floor was 100 sat/kB when measured and 110 gives rounding
 * headroom (0 rejections observed at 110, occasional at 100).
 */
export const FEE_RATE_SATS_PER_KB = 110;

/** ARC publishes the rate its miners will actually accept. */
export const FEE_POLICY_URL = "https://arc.gorillapool.io/v1/policy";

/**
 * Read a sat/kB rate out of an ARC policy response.
 *
 * ⚠ ROUNDS UP, ALWAYS, AND NEVER BELOW THE PUBLISHED RATE. Being one satoshi per
 * kilobyte under the miner's floor is the difference between a broadcast and a
 * rejection — and under paid posting a rejection happens AFTER the author has
 * committed, so it costs them a failed attempt rather than costing us a retry.
 *
 * Split out from the fetch so the parsing is testable without a network.
 */
export function feeRateFromPolicy(body: unknown): number | null {
  const fee = (body as { policy?: { miningFee?: { satoshis?: unknown; bytes?: unknown } } })?.policy
    ?.miningFee;
  const satoshis = fee?.satoshis;
  const bytes = fee?.bytes;
  if (typeof satoshis !== "number" || typeof bytes !== "number") return null;
  if (!Number.isFinite(satoshis) || !Number.isFinite(bytes) || bytes <= 0 || satoshis < 0) {
    return null;
  }
  return Math.max(1, Math.ceil((satoshis / bytes) * 1000));
}

let _feeCache: { value: number; at: number } | null = null;
const FEE_CACHE_MS = 5 * 60_000;

/**
 * The rate miners are currently accepting.
 *
 * ⚠ HARDCODING THIS IS A TIME BOMB. A fixed 110 is safe only while the published
 * floor stays under it; the day it rises, every paid post is rejected with no
 * warning and nothing in our code would say why. Cached for five minutes because
 * the policy does not move minute to minute, and falls back to the constant
 * above on any failure — never below the published rate.
 */
export async function currentFeeRateSatsPerKb(): Promise<number> {
  if (_feeCache && Date.now() - _feeCache.at < FEE_CACHE_MS) return _feeCache.value;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(FEE_POLICY_URL, { signal: ctl.signal }).finally(() =>
      clearTimeout(timer)
    );
    if (!res.ok) return FEE_RATE_SATS_PER_KB;
    const rate = feeRateFromPolicy(await res.json());
    if (rate === null) return FEE_RATE_SATS_PER_KB;
    _feeCache = { value: rate, at: Date.now() };
    return rate;
  } catch {
    // Offline, blocked, or timed out — the fallback is above the floor we last
    // measured, so a post still broadcasts.
    return FEE_RATE_SATS_PER_KB;
  }
}

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
export function postPrice(
  sizeBytes: number,
  opts?: { markupPercent?: number; feeRateSatsPerKb?: number }
): PostPrice {
  // Non-finite in means non-finite out: Math.ceil(NaN) is NaN and Math.max
  // propagates it, so a junk size would quote a NaN price and carry it into a
  // transaction builder. Clamp before any arithmetic.
  const bytes = Number.isFinite(sizeBytes) ? Math.max(0, Math.ceil(sizeBytes)) : 0;
  const rate =
    opts?.feeRateSatsPerKb !== undefined && Number.isFinite(opts.feeRateSatsPerKb)
      ? Math.max(1, Math.ceil(opts.feeRateSatsPerKb))
      : FEE_RATE_SATS_PER_KB;
  const networkFeeSats = Math.ceil((bytes * rate) / 1000);

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
