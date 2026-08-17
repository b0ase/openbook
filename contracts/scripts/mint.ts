import { loadEnv } from './env'
import { Addr, bsv, ContractTransaction, TestWallet } from 'scrypt-ts'
import { BSV20V2P2PKH, Ordinal } from 'scrypt-ord'
import { providerFor } from './provider'
import { Utils } from 'scrypt-ts'
import { PayToMint } from '../src/contracts/payToMint'

/**
 * Mint units from a deployed covenant.
 *
 * ⚠ THE NETWORK COMES FROM THE KEY, never from a flag — see `deploy.ts`. On
 * mainnet the spend is real (113 sats for the first unit) and has to be
 * confirmed with `--mainnet`.
 *
 * ⚠ THIS IS THE TEST THAT ACTUALLY PROVES SOMETHING. The local suite proves the
 * script accepts and refuses the right transactions; only a real spend proves
 * that miners relay it, that the fee is enough, and — the part nothing local can
 * check — that an ORDINALS INDEXER recognises the result as a token. A mint that
 * is mined but never indexed is, to every wallet and marketplace, not a mint.
 * That distinction already cost this project once: an inscription envelope in
 * the wrong order was perfectly valid and completely invisible.
 *
 * Usage:
 *   npm run mint -- <deploy-txid> <amount> [--mainnet]
 */

loadEnv()

async function main() {
    const args = process.argv.slice(2)
    const wantsMainnet = args.includes('--mainnet')
    const positional = args.filter((a) => !a.startsWith('--'))
    const txid = positional[0]
    const amount = BigInt(positional[1] ?? '1')
    if (!txid) throw new Error('usage: npm run mint -- <deploy-txid> <amount> [--mainnet]')

    const wif = process.env.PRIVATE_KEY
    if (!wif) throw new Error('PRIVATE_KEY is not set. Run: npm run genkey')
    const key = bsv.PrivateKey.fromWIF(wif)
    const isMainnet = key.network.name === 'livenet'
    // Same two-signal rule as the deploy: the network is fixed by the key, and
    // spending real money must additionally be typed.
    if (isMainnet && !wantsMainnet) {
        throw new Error('PRIVATE_KEY is a MAINNET key. Re-run with --mainnet if that is intended.')
    }
    if (!isMainnet && wantsMainnet) {
        throw new Error('--mainnet was passed but PRIVATE_KEY is a testnet key.')
    }
    const network = isMainnet ? bsv.Networks.mainnet : bsv.Networks.testnet

    PayToMint.loadArtifact()
    // Same ordinals-aware provider as the deploy — see the note there.
    const signer = new TestWallet(key, providerFor(network))
    const provider = signer.provider
    if (!provider) throw new Error('no provider — cannot read the deployed contract')

    // Recover the live contract from chain rather than reconstructing it from
    // parameters: the state (how much supply is left) only exists on chain, and
    // a locally-rebuilt instance would happily compute a price for a supply that
    // is no longer there.
    const raw = (await provider.getTransaction(txid)) as unknown as bsv.Transaction

    /**
     * ⚠ THE DEPLOYED SCRIPT IS NOT THE CONTRACT TEMPLATE, and `fromTx` says so
     * bluntly: *"the raw script cannot match the ASM template of contract
     * PayToMint"*. `deployToken()` PREPENDS the BSV-21 inscription — that is the
     * whole reason the token is recognised — so the on-chain script is
     * `<inscription envelope> ‖ <contract>`, and matching it against the bare
     * template fails at the first byte.
     *
     * The envelope is a NOP script: unexecuted data the contract carries. So it
     * is split off, handed to `fromTx` as such, and the contract underneath
     * matches. Getting this wrong is not dangerous — it fails loudly before
     * anything is signed — but it is exactly the kind of thing that reads as
     * "the covenant is broken" when the covenant is fine.
     */
    const deployedScript = raw.outputs[0].script
    const nopScript = bsv.Script.fromHex(
        Ordinal.getInsciptionScript(deployedScript.toHex()) as string
    )
    const instance = PayToMint.fromTx(raw, 0, {}, nopScript)
    await instance.connect(signer)

    const minter = Addr(key.toAddress(network).toObject().hash as string)
    const minted = instance.max - instance.supply
    const cost = instance.costOf(minted, amount)
    console.log(`minting ${amount} — ${cost} sats to the treasury`)

    instance.bindTxBuilder(
        'mint',
        async (
            current: PayToMint,
            options: { changeAddress?: bsv.Address },
            amt: bigint,
            to: Addr
        ): Promise<ContractTransaction> => {
            const next = current.next()
            next.supply = current.supply - amt
            next.setAmt(next.supply)

            const received = new BSV20V2P2PKH(
                current.id,
                current.sym,
                current.max,
                current.dec,
                to
            )
            received.setAmt(amt)

            // The order is the contract's, not ours — see `payToMint.ts`.
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(
                    new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 })
                )
                .addOutput(
                    new bsv.Transaction.Output({ script: received.lockingScript, satoshis: 1 })
                )
                .addOutput(
                    new bsv.Transaction.Output({
                        script: bsv.Script.fromHex(
                            Utils.buildPublicKeyHashScript(current.treasury)
                        ),
                        satoshis: Number(current.costOf(current.max - current.supply, amt)),
                    })
                )
                .change(options.changeAddress ?? (await current.signer.getDefaultAddress()))

            return {
                tx,
                atInputIndex: 0,
                nexts: [{ instance: next, balance: 1, atOutputIndex: 0 }],
            }
        }
    )

    const { tx } = await instance.methods.mint(amount, minter, {
        changeAddress: await signer.getDefaultAddress(),
    } as never)

    console.log(`minted   ${amount}`)
    console.log(`  txid   ${tx.id}`)
    console.log('')
    const explorer = isMainnet ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'
    console.log('⚠ MINED IS NOT INDEXED. Check BOTH:')
    console.log(`  ${explorer}/tx/${tx.id}`)
    console.log(`  ordinals indexer — the units at output 1 must show as ${amount} of the token`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
