import { bsv } from 'scrypt-ts'
import { OrdiProvider } from 'scrypt-ord'

/**
 * The provider these scripts broadcast through, with a fee rate miners accept.
 *
 * ⚠ TWO SEPARATE PROBLEMS, BOTH FOUND BY BROADCASTING FOR REAL.
 *
 * **1. `DefaultProvider.getFeePerKb()` returns 1.** Measured, not guessed — one
 * satoshi per kilobyte, which is far below any miner's floor. It produced a
 * 1-satoshi fee on every transaction these scripts built. WhatsOnChain's relay
 * accepted it, so the first attempt looked like it worked; GorillaPool's ARC
 * correctly refused with *"arc error 465: transaction fee is too low, minimum
 * expected fee: 38, actual fee: 1"*. A provider that under-fees and a relay that
 * tolerates it is the worst combination — the mistake only surfaces against the
 * strict endpoint, which is the one that matters.
 *
 * **2. `OrdiProvider` delegates `getFeePerKb()` to that same default provider**,
 * so switching to the ordinals endpoint fixed the broadcast route and inherited
 * the broken rate. Overriding it here is the only place that fixes both.
 *
 * ⚠ DELIBERATELY GENEROUS. The app runs at 110 sat/kB (measured: ARC's floor was
 * 100). ARC wanted 38 satoshis for the deploy transaction, and 110 sat/kB
 * produces almost exactly 38 — passing by rounding is not passing. These scripts
 * run a handful of times by hand, so the trade is not close: a fee that is too
 * low costs a failed broadcast and a confusing error, while a fee that is too
 * high costs a fraction of a US cent. At 500 sat/kB a deploy pays ~170 satoshis,
 * which is about two thousandths of a cent.
 *
 * This is NOT the rate the app should use — `post-economics.ts` reads the live
 * ARC policy for that, because it is paying on every post and the difference
 * compounds. Here it does not.
 */
const SCRIPT_FEE_PER_KB = 500

export class FundedOrdiProvider extends OrdiProvider {
    getFeePerKb(): Promise<number> {
        return Promise.resolve(SCRIPT_FEE_PER_KB)
    }
}

/** The provider for a given network, with the fee rate applied. */
export function providerFor(network: bsv.Networks.Network): FundedOrdiProvider {
    // The bsv global matters too: some code paths inside the tx builder read it
    // rather than asking the provider, and a mismatch between the two is exactly
    // the kind of thing that only shows up as a rejected broadcast.
    //
    // Cast because `FEE_PER_KB` is missing from the bundled type definitions but
    // is genuinely there at runtime — read back as 50 before this line runs.
    // Verified, not assumed.
    ;(bsv.Transaction as unknown as { FEE_PER_KB: number }).FEE_PER_KB = SCRIPT_FEE_PER_KB
    return new FundedOrdiProvider(network)
}
