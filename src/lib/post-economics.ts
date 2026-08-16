/**
 * What a post costs to mint, and what the platform takes for minting it.
 *
 * A post's price has two parts, and they answer to different things:
 *
 *  - **Cost-plus, flat** — the miner fee, the inscribed satoshi, and a markup
 *    on top. This is what it costs to put a post on chain and stays flat
 *    however popular the board gets. That part is priced here.
 *  - **The mint curve** — what the `$Ticker`s named in the post cost to mint,
 *    which RISES with each word's supply. Priced in `mint-charge.ts` and passed
 *    in as `mintSats`, because it depends on the database and this module is
 *    pure arithmetic.
 *
 * ⚠ THE CURVE IS NOW CHARGED (owner, 2026-08-16: *"do the curve"*). This file
 * previously said flat cost-plus SUPERSEDED the curve, on the "a token is a
 * RECEIPT" decision — that has been reversed, and DECISIONS.md records both the
 * reversal and why. The curve is what makes a seat appreciate and what puts a
 * ceiling on resale; a receipt has neither, and the token had to be worth
 * holding. See `mint-price.ts` for the mechanism.
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
  /**
   * What the `$Ticker`s in this post cost to mint, from the curve. Zero for a
   * post that names none — most posts. Priced by `mint-charge.ts`.
   */
  mintSats: number;
  /**
   * ⚠ WHAT THE ONE PLATFORM OUTPUT MUST CARRY — markup plus mint, together.
   *
   * They travel in a single output on purpose. Two outputs would double the
   * cost of collecting them (every UTXO costs ~148 bytes to spend later) and
   * would tell an observer nothing the amounts do not already say. The builder
   * reads THIS, never `platformFeeSats`: building from the markup alone is how
   * a post gets broadcast underpaid and refused after the author has paid.
   */
  platformOutputSats: number;
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

/**
 * The configured markup.
 *
 * ⚠ EXPORTED SO THERE IS EXACTLY ONE OF THESE. `getPostingMode` had its own copy
 * and re-introduced the `Number("") === 0` bug this function exists to avoid:
 * with the env var unset the client was told 0%, built no platform output, and
 * the server then refused the post for underpayment — AFTER the author had
 * broadcast and paid. Client and server must read the same number from the same
 * place or the user funds a transaction we then reject.
 */
export function configuredMarkupPercent(): number {
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
  opts?: { markupPercent?: number; feeRateSatsPerKb?: number; mintSats?: number }
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
      : configuredMarkupPercent();
  // The markup is taken on the cost we actually incur (the miner fee plus the
  // satoshi we hand the author), not on an invented notional price.
  const cost = networkFeeSats + INSCRIPTION_SATS;
  const rawMarkup = Math.ceil((cost * pct) / 100);

  // ⚠ A percentage of a fraction of a penny rounds to something unpayable. When
  // that happens the floor binds, and the effective markup is higher than the
  // configured one — `floored` says so rather than leaving it to be discovered.
  const floored = pct > 0 && rawMarkup < MIN_ECONOMIC_OUTPUT_SATS;
  const platformFeeSats = pct === 0 ? 0 : Math.max(rawMarkup, MIN_ECONOMIC_OUTPUT_SATS);

  // ⚠ CLAMPED LIKE THE SIZE, FOR THE SAME REASON. A NaN or negative mint charge
  // would propagate straight into an output amount, and a transaction builder is
  // the last place that should be discovering junk arithmetic.
  const rawMint = opts?.mintSats;
  const mintSats =
    rawMint !== undefined && Number.isFinite(rawMint) ? Math.max(0, Math.ceil(rawMint)) : 0;

  return {
    networkFeeSats,
    inscriptionSats: INSCRIPTION_SATS,
    platformFeeSats,
    mintSats,
    platformOutputSats: platformFeeSats + mintSats,
    totalSats: networkFeeSats + INSCRIPTION_SATS + platformFeeSats + mintSats,
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

/**
 * The least the platform may be paid for a post to be accepted.
 *
 * ⚠ DERIVED FROM THE CONFIGURED MARKUP, NOT A CONSTANT. Demanding a floor while
 * the markup is 0 makes at-cost posting impossible — and it fails in the worst
 * possible way, because the author has already broadcast by the time the server
 * checks. Zero markup means zero required.
 */
export function minimumPlatformSats(): number {
  return configuredMarkupPercent() === 0 ? 0 : MIN_ECONOMIC_OUTPUT_SATS;
}
