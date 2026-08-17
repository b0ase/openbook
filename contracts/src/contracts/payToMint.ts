import {
    Addr,
    ByteString,
    assert,
    hash256,
    method,
    prop,
    Utils,
} from 'scrypt-ts'
import { BSV20V2 } from 'scrypt-ord'

/**
 * Pay-to-mint: a ticker's unissued supply, held by a script rather than a key.
 *
 * ⚠ WHAT THIS REPLACES. Today a `$Ticker` unit is a row in `ticker_holdings`.
 * Real money is charged for it and the post that names the word is genuinely
 * inscribed — but the units are a database ledger, which means the platform is
 * trusted to apply transfers. TOKENS.md is explicit that this is a real
 * assumption. Here the supply lives in a contract UTXO, the price is enforced
 * by the script, and a mint is valid because the chain says so.
 *
 * ⚠ PERMISSIONLESS BY DESIGN — `mint` takes no signature. Anyone who pays may
 * mint, exactly like OrdLock's purchase branch, which also requires no
 * signature from the buyer. That is the point: the payment IS the authorisation,
 * and nothing has to attest that somebody earned their tokens.
 *
 * The structure is POW-20's (`HashToMintBsv20`) with OrdLock's predicate
 * substituted for the hash puzzle — supply in a contract UTXO, released when the
 * spending transaction contains the required payment. It is SIMPLER than POW-20
 * because a payment output is natively verifiable: no difficulty schedule, and
 * no oracle, because *"did this transaction pay X to Y"* is answerable on chain.
 *
 * Every mint transaction must look exactly like this:
 *
 *     Output 0  [transfer inscription: amt = supply - amount]  [this contract]
 *     Output 1  [transfer inscription: amt = amount]           [P2PKH → minter]
 *     Output 2  payment                                        [P2PKH → treasury]
 *     Output 3+ change (the spender's own)
 *
 * and `hash256(outputs) === this.ctx.hashOutputs` is what makes that binding.
 * The spender cannot alter the amounts, redirect the payment, or drop the
 * continuation — doing any of those changes the hash and the script fails.
 */
export class PayToMint extends BSV20V2 {
    /**
     * Units NOT yet issued, held by this UTXO.
     *
     * Minted-so-far is `max - supply`, and is derived rather than stored: two
     * stateful props that must always sum to a constant is one more thing that
     * can disagree with itself, and every byte of state is paid for in every
     * mint transaction.
     */
    @prop(true)
    supply: bigint

    /** Where the mint price must be paid. Fixed at deploy. */
    @prop()
    readonly treasury: Addr

    /**
     * Satoshis for the FIRST unit. The Nth unit costs `N × basePrice`.
     *
     * ⚠ LINEAR, AND THE SLOPE IS THE WHOLE MECHANISM — the same curve
     * `src/lib/mint-price.ts` implements off-chain. See `costOf` for why those
     * two must agree to the satoshi.
     */
    @prop()
    readonly basePrice: bigint

    constructor(
        id: ByteString,
        sym: ByteString,
        max: bigint,
        dec: bigint,
        treasury: Addr,
        basePrice: bigint
    ) {
        super(id, sym, max, dec)
        this.init(...arguments)
        this.supply = max
        this.treasury = treasury
        this.basePrice = basePrice
    }

    /**
     * What it costs to take `amount` units when `minted` already exist.
     *
     * ⚠ THIS MUST EQUAL `mintCostForRange` IN `src/lib/mint-price.ts` TO THE
     * SATOSHI. The client builds the payment from that function and this script
     * decides whether to accept it — so a disagreement of one satoshi is a mint
     * that can never succeed, discovered only by broadcasting.
     *
     * Both are the sum of an arithmetic series. The Nth unit costs `N × base`,
     * so taking units `m+1 … m+a` costs
     *
     *     base × [ (m+a)(m+a+1)/2 − m(m+1)/2 ]
     *
     * The closed form is used rather than a loop because a loop in script must
     * be bounded at compile time, which would cap how many units one
     * transaction could ever mint.
     */
    @method()
    costOf(minted: bigint, amount: bigint): bigint {
        const to: bigint = minted + amount
        // Integer division is exact here: n(n+1) is always even.
        const sumTo: bigint = (to * (to + 1n)) / 2n
        const sumFrom: bigint = (minted * (minted + 1n)) / 2n
        return this.basePrice * (sumTo - sumFrom)
    }

    /**
     * Release `amount` units to `minter`, in exchange for paying the treasury.
     *
     * ⚠ THE ONLY OUTPUT THE SPENDER CHOOSES IS THEIR OWN CHANGE. An earlier
     * version took a `trailingOutputs: ByteString` argument, letting the spender
     * append whatever they liked after the three fixed outputs. That is how
     * OrdLock works, and it is right there — a purchase should be composable
     * into a larger transaction. Here it buys nothing: a mint has no reason to
     * carry extra outputs, and every byte the spender controls is a byte
     * somebody has to reason about. `buildChangeOutput` is sCrypt's own
     * accounting for exactly this, so the change amount is checked rather than
     * asserted by us.
     */
    @method()
    public mint(amount: bigint, minter: Addr) {
        // ⚠ BOTH BOUNDS MATTER. Zero would let somebody spin the contract
        // forward paying nothing; more than the supply would mint units that
        // were never deployed, which the BSV-21 accounting cannot represent.
        assert(amount > 0n, 'amount must be positive')
        assert(amount <= this.supply, 'not enough supply left')

        const minted: bigint = this.max - this.supply
        const cost: bigint = this.costOf(minted, amount)

        // The continuation: same script, less supply.
        this.supply -= amount
        let outputs: ByteString = this.buildStateOutputFT(this.supply)

        // The units themselves, as a BSV-21 transfer to the minter.
        outputs += BSV20V2.buildTransferOutput(minter, this.id, amount)

        // ⚠ THE PAYMENT IS BUILT BY THE CONTRACT, NOT PUSHED BY THE SPENDER —
        // the same reason OrdLock stores its payout output inside the locking
        // script. If the spender supplied these bytes they would supply a
        // cheaper amount or their own address.
        outputs += Utils.buildPublicKeyHashOutput(this.treasury, cost)

        // The spender's change — the one part of this transaction they choose.
        outputs += this.buildChangeOutput()

        // The one line that makes all of the above binding.
        assert(
            hash256(outputs) === this.ctx.hashOutputs,
            'outputs do not match the required shape'
        )
    }
}
