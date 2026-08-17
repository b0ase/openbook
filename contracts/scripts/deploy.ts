import { loadEnv } from './env'
import { Addr, bsv, DefaultProvider, TestWallet, toByteString } from 'scrypt-ts'
import { PayToMint } from '../src/contracts/payToMint'

/**
 * Deploy one ticker's supply into a pay-to-mint covenant.
 *
 * ⚠ MAINNET, BY THE OWNER'S DECISION (2026-08-17). Both testnet faucets were
 * dead for him, and his call was: *"just do the tests on main-net — and if needs
 * be discard the tests when it's time to do the real thing."* That is a
 * reasonable trade at these amounts: a deploy is ~200 sats and a mint 113, so
 * mainnet iteration costs a fraction of a cent. **The risk was never losing
 * money. The risk is a covenant bug locking a token's unissued supply in a UTXO
 * nobody can ever spend, forever** — which is why the symbol used here must be
 * DISPOSABLE and thrown away before any real word is deployed.
 *
 * ⚠ NOTHING HERE TOUCHES THE LIVE APP. It does not read the app's database and
 * it must never be given `BSV_SERVER_WIF`. What crosses the boundary if this
 * ships is DATA — a deployed outpoint and its parameters — never code.
 *
 * Usage:
 *   npm run genkey -- --mainnet      # writes .env, prints an address to fund
 *   # send it ~2000 sats from your own wallet — NOT the server key
 *   npm run deploy -- '$TESTMINT1' --mainnet
 */

/**
 * ⚠ THE MAX IS A CAP AND BSV-21 GIVES US NO CHOICE ABOUT HAVING ONE.
 *
 * The design is progressive pay-to-mint — no pre-mint, nothing sold to anybody
 * up front. But BSV-21 fixes `max` at deploy, so "uncapped" is not literally
 * expressible. The honest construction is a ceiling far above anything the curve
 * can reach, held in the covenant rather than at anyone's address: at 113 sats
 * base, minting all 21,000,000 units would cost roughly 250,000 BSV. The cap
 * exists to satisfy the protocol, not to create scarcity — and TOKENS.md's rule
 * survives: *a cap enforced by a covenant is fine; a cap enforced by us is not.*
 */
const MAX_SUPPLY = 21_000_000n

/** Matches `MINT_BASE_SATS` in `src/lib/mint-price.ts`. */
const BASE_PRICE = 113n

/**
 * ⚠ A TEST KEY MUST BE NEARLY EMPTY, and this is the guard that catches the
 * worst plausible mistake: pasting the platform's own `BSV_SERVER_WIF` in here.
 * That wallet held 663,647 sats when this was written. A deploy needs a few
 * hundred — so a balance above this ceiling means the key is not what the
 * operator thinks it is, and the script stops rather than spending from it.
 */
const MAX_TEST_BALANCE_SATS = 50_000

loadEnv()

async function main() {
    const args = process.argv.slice(2)
    const wantsMainnet = args.includes('--mainnet')
    const symbol = (args.find((a) => !a.startsWith('--')) ?? '').replace(/^\$/, '').toUpperCase()
    if (!symbol) {
        throw new Error("usage: npm run deploy -- '$SYMBOL' [--mainnet]")
    }

    const wif = process.env.PRIVATE_KEY
    if (!wif) throw new Error('PRIVATE_KEY is not set. Run: npm run genkey')

    const key = bsv.PrivateKey.fromWIF(wif)
    const isMainnet = key.network.name === 'livenet'

    // ⚠ MAINNET CANNOT HAPPEN BY ACCIDENT. The network comes from the KEY — so
    // it cannot be mismatched — and spending real money additionally requires
    // saying so on the command line. Two independent signals, one of them typed
    // deliberately every single time.
    if (isMainnet && !wantsMainnet) {
        throw new Error(
            'PRIVATE_KEY is a MAINNET key. Re-run with --mainnet if that is what you mean.'
        )
    }
    if (!isMainnet && wantsMainnet) {
        throw new Error('--mainnet was passed but PRIVATE_KEY is a testnet key.')
    }

    const network = isMainnet ? bsv.Networks.mainnet : bsv.Networks.testnet
    const address = key.toAddress(network).toString()
    const provider = new DefaultProvider({ network })

    if (isMainnet) {
        const balance = await provider.getBalance(key.toAddress(network))
        const total = balance.confirmed + balance.unconfirmed
        if (total > MAX_TEST_BALANCE_SATS) {
            throw new Error(
                `Refusing to deploy from a wallet holding ${total} sats. A test key should be ` +
                    `nearly empty (ceiling ${MAX_TEST_BALANCE_SATS}). If this is the platform's ` +
                    'server wallet, it must never be used here — generate a fresh key.'
            )
        }
        if (total === 0) {
            throw new Error(`No funds at ${address}. Send it ~2000 sats and try again.`)
        }
        console.log(`⚠ MAINNET. Deploying $${symbol} from ${address} (${total} sats available).`)
        console.log('  Use a DISPOSABLE symbol — this is a test, and the supply is unrecoverable')
        console.log('  if the covenant is wrong.')
        console.log('')
    }

    PayToMint.loadArtifact()
    const signer = new TestWallet(key, provider)

    // The treasury is the deployer here. In production it is the platform
    // address, and it is FIXED AT DEPLOY — a treasury that could be repointed
    // later is a treasury the deployer can aim at themselves.
    const treasury = Addr(key.toAddress(network).toObject().hash as string)

    const instance = new PayToMint(
        // Genesis: BSV-21 assigns the id from this deploy's own outpoint, which
        // cannot be known before the transaction exists.
        toByteString(''),
        toByteString(symbol, true),
        MAX_SUPPLY,
        0n,
        treasury,
        BASE_PRICE
    )
    await instance.connect(signer)

    const tx = await instance.deploy(1)
    const explorer = isMainnet ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'

    console.log(`deployed  $${symbol}`)
    console.log(`  txid     ${tx.id}`)
    console.log(`  outpoint ${tx.id}_0`)
    console.log(`  treasury ${address}`)
    console.log(`  supply   ${MAX_SUPPLY} at ${BASE_PRICE} sats base`)
    console.log('')
    console.log('⚠ LANDING IS NOT THE SAME AS BEING RECOGNISED. Check both:')
    console.log(`  ${explorer}/tx/${tx.id}`)
    if (isMainnet) {
        console.log(`  https://ordinals.gorillapool.io/api/inscriptions/txid/${tx.id}`)
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
})
