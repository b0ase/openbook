import { expect } from 'chai'
import {
    Addr,
    type ByteString,
    type ContractTransaction,
    DummyProvider,
    TestWallet,
    Utils,
    bsv,
    toByteString,
} from 'scrypt-ts'
import { BSV20V2P2PKH } from 'scrypt-ord'
import { PayToMint } from '../src/contracts/payToMint'
import { mintCostForRange } from '../../src/lib/mint-price'

/**
 * The covenant, tested by trying to break it.
 *
 * ⚠ A COVENANT BUG IS NOT A THROWN ERROR. It permanently locks a token's entire
 * unissued supply in a UTXO nobody can ever spend, or lets somebody take the
 * supply without paying. Neither is recoverable, and neither shows up in a happy
 * path — so almost every test here is an attack, and the ones that matter are
 * the ones asserting a REJECTION.
 *
 * Offline: `DummyProvider` never broadcasts. What is being verified is the
 * script, which is the only thing that will be enforcing any of this once it is
 * on chain.
 */

const BASE = 113n
const MAX = 21_000_000n

const treasuryKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
const TREASURY = Addr(treasuryKey.toAddress().toObject().hash as string)
const minterKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
const MINTER = Addr(minterKey.toAddress().toObject().hash as string)

/**
 * ⚠ THE ARTIFACT IS THE COMPILED SCRIPT, and it must be loaded before any
 * instance exists — the class is a description until then, and `costOf` below
 * is evaluated by the same compiled code the chain will run, not by TypeScript.
 * That is the whole reason these assertions mean anything.
 */
before(() => {
    PayToMint.loadArtifact()
})

/**
 * A CONCRETE token id, not genesis (`''`).
 *
 * BSV-21 assigns an id from the deploy outpoint on first spend, and `setAmt`
 * refuses to work until it exists. That resolution is worth its own test; here
 * it would only mean every covenant test failed for a reason that has nothing
 * to do with the covenant.
 */
const TOKEN_ID = toByteString(
    `${'ab'.repeat(32)}_0`,
    true
)

async function deployed(): Promise<PayToMint> {
    const instance = new PayToMint(
        TOKEN_ID,
        toByteString('OCCAM', true),
        MAX,
        0n,
        TREASURY,
        BASE
    )
    await instance.connect(new TestWallet(treasuryKey, new DummyProvider()))
    return instance
}

describe('PayToMint — the price', () => {
    /**
     * ⚠ THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. The client builds the
     * payment from `mintCostForRange`; this script decides whether to accept it.
     * A disagreement of ONE SATOSHI is a mint that can never succeed, and it
     * would be discovered by broadcasting rather than by testing.
     *
     * Imported from the app deliberately. The contract workspace is isolated so
     * the sCrypt toolchain cannot reach the Next build — but a TEST reading the
     * app's pure curve is exactly how the two are held together.
     */
    it('agrees with the app, to the satoshi, across the range', async () => {
        const instance = await deployed()
        for (const minted of [0n, 1n, 2n, 7n, 50n, 999n]) {
            for (const amount of [1n, 2n, 5n, 100n]) {
                const onChain = instance.costOf(minted, amount)
                const offChain = mintCostForRange(Number(minted), Number(amount), Number(BASE))
                expect(onChain.toString()).to.equal(
                    String(offChain),
                    `minted=${minted} amount=${amount}`
                )
            }
        }
    })

    it('prices the first unit at base, and the Nth at N × base', async () => {
        const instance = await deployed()
        expect(instance.costOf(0n, 1n)).to.equal(BASE)
        expect(instance.costOf(1n, 1n)).to.equal(2n * BASE)
        expect(instance.costOf(9n, 1n)).to.equal(10n * BASE)
    })

    it('is quadratic in the size of the buy — cornering a word is expensive', async () => {
        const instance = await deployed()
        // 1+2+…+10 = 55 units of base, not 10.
        expect(instance.costOf(0n, 10n)).to.equal(55n * BASE)
    })
})

/**
 * The covenant itself.
 *
 * Each test builds a real spending transaction and asks the compiled script to
 * accept it. The ones that must FAIL are the point: a covenant that only works
 * on the happy path is not a covenant, it is a suggestion.
 */
describe('PayToMint — the covenant', () => {
    /**
     * Build a mint transaction with every knob exposed, so a test can bend one
     * of them and watch the script refuse.
     *
     * ⚠ THE BUILDER IS THE ATTACKER HERE. In production this shape comes from
     * our own client, but on chain ANYONE can construct the spending
     * transaction — so the tests construct hostile ones directly rather than
     * going through a helper that would only ever produce honest output.
     */
    function builderFor(opts: {
        amountTaken?: bigint
        amountPaidFor?: bigint
        payTo?: Addr
        payLess?: bigint
        dropContinuation?: boolean
    }) {
        return async function (
            current: PayToMint,
            options: any,
            amount: bigint,
            minter: Addr
        ): Promise<ContractTransaction> {
            const taken = opts.amountTaken ?? amount
            const cost =
                current.costOf(current.max - current.supply, opts.amountPaidFor ?? amount) -
                (opts.payLess ?? 0n)

            const next = current.next()
            next.supply = current.supply - taken

            const tx = new bsv.Transaction().addInput(current.buildContractInput())

            // Output 0 — the contract carrying on with less supply.
            if (!opts.dropContinuation) {
                next.setAmt(next.supply)
                tx.addOutput(
                    new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 })
                )
            }

            // Output 1 — the units, to the minter.
            const received = new BSV20V2P2PKH(
                current.id,
                current.sym,
                current.max,
                current.dec,
                minter
            )
            received.setAmt(taken)
            tx.addOutput(
                new bsv.Transaction.Output({ script: received.lockingScript, satoshis: 1 })
            )

            // Output 2 — the payment.
            tx.addOutput(
                new bsv.Transaction.Output({
                    script: bsv.Script.fromHex(
                        Utils.buildPublicKeyHashScript(opts.payTo ?? current.treasury)
                    ),
                    satoshis: Number(cost),
                })
            )

            tx.change(await current.signer.getDefaultAddress())

            return {
                tx,
                atInputIndex: 0,
                nexts: opts.dropContinuation
                    ? []
                    : [{ instance: next, balance: 1, atOutputIndex: 0 }],
            }
        }
    }

    async function attempt(opts: Parameters<typeof builderFor>[0], amount = 3n) {
        const instance = await deployed()
        await instance.deploy(1)
        instance.bindTxBuilder('mint', builderFor(opts) as any)
        return instance.methods.mint(amount, MINTER, {
            changeAddress: await instance.signer.getDefaultAddress(),
        } as any)
    }

    it('ACCEPTS a mint that pays the asking price', async () => {
        // The happy path exists to prove the failures below are meaningful —
        // a covenant that rejects everything passes every attack test.
        await attempt({})
    })

    it('REFUSES a mint that pays less than the price', async () => {
        await expectRejection(attempt({ payLess: 1n }), 'underpaying by one satoshi')
    })

    it('REFUSES a payment sent anywhere but the treasury', async () => {
        await expectRejection(attempt({ payTo: MINTER }), 'redirecting the payment')
    })

    it('REFUSES taking more units than were paid for', async () => {
        // Pay for one, take ten — the attack the price check exists to stop.
        await expectRejection(
            attempt({ amountTaken: 10n, amountPaidFor: 1n }),
            'taking more than was paid for'
        )
    })

    it('REFUSES dropping the continuation and walking off with the supply', async () => {
        // Without output 0 the remaining supply is simply gone — this is the
        // one that would empty a token in a single transaction.
        await expectRejection(attempt({ dropContinuation: true }), 'omitting the continuation')
    })

    it('REFUSES minting zero', async () => {
        await expectRejection(attempt({}, 0n), 'minting nothing')
    })

    it('REFUSES minting more than the supply left', async () => {
        await expectRejection(attempt({}, MAX + 1n), 'minting beyond the deployed supply')
    })
})

/**
 * Assert the SCRIPT rejected — not that something, somewhere, threw.
 *
 * ⚠ THIS DISTINCTION IS THE WHOLE VALUE OF THESE TESTS. Every rejection test
 * passed at first while the happy path was broken by a harness bug: they were
 * "passing" on `token id is not initialized`, which proves nothing about the
 * covenant. A test that cannot tell a refusal from a crash is worse than no
 * test, because it reports safety it never checked.
 */
const HARNESS_ERRORS = [
    'not initialized',
    'is not a function',
    'Cannot read',
    'undefined',
]

async function expectRejection(p: Promise<unknown>, what: string): Promise<void> {
    let message: string | null = null
    try {
        await p
    } catch (e) {
        message = e instanceof Error ? e.message : String(e)
    }
    expect(message, `the covenant ACCEPTED ${what}`).to.not.equal(null)
    for (const harness of HARNESS_ERRORS) {
        expect(
            message?.includes(harness),
            `${what} was rejected by the TEST HARNESS, not the script: ${message}`
        ).to.equal(false)
    }
}
