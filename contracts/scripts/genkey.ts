import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bsv } from 'scrypt-ts'

/**
 * Generate a TESTNET key for deploying the covenant, and say where to fund it.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN `scrypt-cli genprivkey`. That command was in the
 * instructions and **does not exist** — scrypt-cli 0.2.3 has project, compile,
 * deploy, verify, system, init and version, and nothing else. Written from
 * memory, not checked, and it cost the owner a confusing error. Owning the
 * script means the instruction cannot rot again.
 *
 * ⚠ THE KEY NEVER LEAVES THIS MACHINE AND IS NEVER PRINTED. It is written to
 * `.env`, which is gitignored (the root rule is `.env*`, unanchored, so it
 * matches here too — verified). Only the ADDRESS is printed, because that is the
 * part you paste into a faucet. A WIF on a terminal is a WIF in scrollback, in a
 * screenshot, and in whatever syncs your clipboard.
 *
 * ⚠ REFUSES TO OVERWRITE. If `.env` already holds a key, running this again
 * would orphan whatever that key holds — including, later, a deployed contract
 * you can no longer spend from.
 */

const ENV_PATH = join(__dirname, '..', '.env')

function main() {
    // ⚠ MAINNET IS OPT-IN AND MUST BE TYPED. The owner's testnet faucets were
    // both dead (2026-08-17) and his decision was to test on mainnet and discard
    // the results. A key that spends real money is never the default.
    const mainnet = process.argv.includes('--mainnet')
    if (existsSync(ENV_PATH)) {
        console.error(
            'contracts/.env already exists — refusing to overwrite it.\n' +
                'If you genuinely want a new key, move the old file aside first:\n' +
                '  mv contracts/.env contracts/.env.old'
        )
        process.exit(1)
    }

    // ⚠ THE NETWORK IS BAKED INTO THE KEY, which is what makes it impossible to
    // mismatch later: `deploy.ts` reads the network FROM the key rather than
    // from a flag, so a testnet key can never spend real money and a mainnet key
    // additionally has to be confirmed on the command line.
    const network = mainnet ? bsv.Networks.mainnet : bsv.Networks.testnet
    const key = bsv.PrivateKey.fromRandom(network)
    const address = key.toAddress(network).toString()

    writeFileSync(ENV_PATH, `PRIVATE_KEY=${key.toWIF()}\n`, { mode: 0o600 })

    console.log(
        `Wrote a ${mainnet ? 'MAINNET' : 'TESTNET'} key to contracts/.env (gitignored, mode 600).`
    )
    console.log('')
    console.log('  address   ' + address)
    console.log('')
    if (mainnet) {
        console.log('⚠ THIS KEY SPENDS REAL MONEY. Send it ~2000 sats — enough for a deploy')
        console.log('  (~200) and a few mints (113 each). Do NOT reuse the platform server key:')
        console.log('  the deploy script refuses any wallet holding more than 50,000 sats,')
        console.log('  precisely to catch that mistake.')
        console.log('')
        console.log('Then, from contracts/:')
        console.log("  npm run deploy -- '$TESTMINT1' --mainnet")
    } else {
        console.log('Fund it — testnet coins are free and worth nothing:')
        console.log('  https://witnessonchain.com/faucet/tbsv')
        console.log('  https://scrypt.io/faucet')
        console.log('')
        console.log('Then, from contracts/:')
        console.log("  npm run deploy -- '$THROWAWAY'")
    }
    console.log('')
    console.log('The key itself is not printed. It is in .env and it should stay there.')
}

main()
