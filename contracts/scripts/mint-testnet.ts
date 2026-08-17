import { Addr, bsv, ContractTransaction, DefaultProvider, TestWallet } from 'scrypt-ts'
import { BSV20V2P2PKH } from 'scrypt-ord'
import { Utils } from 'scrypt-ts'
import { PayToMint } from '../src/contracts/payToMint'

/**
 * Mint units from a deployed covenant. **TESTNET ONLY.**
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
 *   npx ts-node scripts/mint-testnet.ts <deploy-txid> <amount>
 */

async function main() {
    const txid = process.argv[2]
    const amount = BigInt(process.argv[3] ?? '1')
    if (!txid) throw new Error('usage: ts-node scripts/mint-testnet.ts <deploy-txid> <amount>')

    const wif = process.env.PRIVATE_KEY
    if (!wif) throw new Error('PRIVATE_KEY is not set. Run: npm run genkey')
    const key = bsv.PrivateKey.fromWIF(wif)
    if (key.network.name !== 'testnet') {
        throw new Error('PRIVATE_KEY is not a testnet key. This script is testnet only.')
    }

    PayToMint.loadArtifact()
    const signer = new TestWallet(key, new DefaultProvider({ network: bsv.Networks.testnet }))
    const provider = signer.provider
    if (!provider) throw new Error('no provider — cannot read the deployed contract')

    // Recover the live contract from chain rather than reconstructing it from
    // parameters: the state (how much supply is left) only exists on chain, and
    // a locally-rebuilt instance would happily compute a price for a supply that
    // is no longer there.
    const raw = await provider.getTransaction(txid)
    const instance = PayToMint.fromTx(raw as unknown as bsv.Transaction, 0)
    await instance.connect(signer)

    const minter = Addr(key.toAddress().toObject().hash as string)
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
    console.log('⚠ MINED IS NOT INDEXED. Check BOTH:')
    console.log(`  https://test.whatsonchain.com/tx/${tx.id}`)
    console.log(`  ordinals indexer — the units at output 1 must show as ${amount} of the token`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
