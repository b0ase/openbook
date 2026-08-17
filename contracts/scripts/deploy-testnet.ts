import { Addr, bsv, TestWallet, DefaultProvider, toByteString } from 'scrypt-ts'
import { PayToMint } from '../src/contracts/payToMint'

/**
 * Deploy one ticker's supply into a pay-to-mint covenant. **TESTNET ONLY.**
 *
 * ⚠ NOTHING HERE TOUCHES THE LIVE APP. The app does not import this directory,
 * and this script does not read the app's database or its server key. What
 * crosses the boundary if this ever ships is DATA — a deployed outpoint and its
 * parameters — never code.
 *
 * ⚠ RUN ORDER, AND IT IS NOT NEGOTIABLE. A covenant bug is not a thrown error:
 * it permanently locks a token's entire unissued supply in a UTXO nobody can
 * ever spend. So: local tests pass → deploy a THROWAWAY symbol here → confirm
 * an indexer sees the deploy, a mint and a transfer → only then does anything
 * real go near it. The same discipline that gated paid posting until GorillaPool
 * confirmed a real inscription.
 *
 * Usage:
 *   npx scrypt-cli genprivkey        # writes .env, prints an address to fund
 *   # fund that address from a BSV testnet faucet
 *   npx ts-node scripts/deploy-testnet.ts $THROWAWAY
 */

/**
 * ⚠ THE MAX IS A CAP, AND BSV-21 GIVES US NO CHOICE ABOUT HAVING ONE.
 *
 * The design is progressive pay-to-mint — no pre-mint, no fixed supply sold to
 * anybody. But BSV-21 fixes `max` at deploy, so "uncapped" is not literally
 * expressible: the honest construction is a ceiling far above anything the curve
 * will ever reach, held in the covenant rather than at anyone's address.
 *
 * At 113 sats base, minting all 21,000,000 units would cost about 2.5 × 10^13
 * satoshis — roughly 250,000 BSV. The cap is unreachable by arithmetic, which is
 * the point: it exists to satisfy the protocol, not to create scarcity. And
 * TOKENS.md's rule is preserved — *a cap enforced by a covenant is fine; a cap
 * enforced by us is not.*
 */
const MAX_SUPPLY = 21_000_000n

/** Matches `MINT_BASE_SATS` in `src/lib/mint-price.ts`. */
const BASE_PRICE = 113n

async function main() {
    const symbol = (process.argv[2] ?? '').replace(/^\$/, '').toUpperCase()
    if (!symbol) {
        throw new Error('usage: ts-node scripts/deploy-testnet.ts $SYMBOL')
    }

    const wif = process.env.PRIVATE_KEY
    if (!wif) {
        throw new Error(
            'PRIVATE_KEY is not set. Run `npx scrypt-cli genprivkey` — it writes a ' +
                'TESTNET key to .env (gitignored) and prints an address to fund from a faucet.'
        )
    }

    const key = bsv.PrivateKey.fromWIF(wif)
    // ⚠ REFUSE TO RUN AGAINST MAINNET. A mainnet key here would deploy a real
    // token with real money at a base price meant for a throwaway test.
    if (key.network.name !== 'testnet') {
        throw new Error('PRIVATE_KEY is not a testnet key. This script is testnet only.')
    }

    PayToMint.loadArtifact()
    const signer = new TestWallet(key, new DefaultProvider({ network: bsv.Networks.testnet }))

    // The treasury is the deployer here. In production it is the platform
    // address, and it is FIXED AT DEPLOY — a treasury that could be changed
    // later is a treasury the deployer can point at themselves.
    const treasury = Addr(key.toAddress().toObject().hash as string)

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
    console.log(`deployed  $${symbol}`)
    console.log(`  txid    ${tx.id}`)
    console.log(`  outpoint ${tx.id}_0`)
    console.log(`  treasury ${key.toAddress().toString()}`)
    console.log(`  supply   ${MAX_SUPPLY} at ${BASE_PRICE} sats base`)
    console.log('')
    console.log('Verify BEFORE trusting it — the transaction landing is not the same')
    console.log('as an indexer recognising a token:')
    console.log(`  https://test.whatsonchain.com/tx/${tx.id}`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
