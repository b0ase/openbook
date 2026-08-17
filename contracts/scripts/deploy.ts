import { Addr, bsv, TestWallet, toByteString } from "scrypt-ts";
import { PayToMint } from "../src/contracts/payToMint";
import { loadEnv } from "./env";
import { providerFor } from "./provider";

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
const MAX_SUPPLY = 21_000_000n;

/** Matches `MINT_BASE_SATS` in `src/lib/mint-price.ts`. */
const BASE_PRICE = 113n;

/**
 * A smell test on the funding wallet — and an honest note about what it is NOT.
 *
 * ⚠ I ORIGINALLY SET THIS AT 50,000 SATS AND CLAIMED IT WOULD CATCH SOMEBODY
 * PASTING THE PLATFORM'S `BSV_SERVER_WIF`. It would not, and the number was
 * wrong twice over. 50,000 sats is about half a US cent; the owner funded this
 * key with 654,236 sats, which is **7.6 cents** — an entirely sensible amount
 * that my ceiling would have refused. And the platform's whole operating wallet
 * holds 663,647 sats, i.e. almost exactly the same, so **no balance threshold
 * can tell the two apart.** I had mis-sized what "a lot" means on this chain.
 *
 * What actually protects the funds is structural, not this number:
 *   - a deploy spends the FEE plus one satoshi. The balance is never at risk,
 *     whatever it is — the rest comes back as change.
 *   - the address and balance are PRINTED before anything is broadcast, so a
 *     wrong key is visible to the person about to spend from it.
 *   - `--mainnet` has to be typed.
 *
 * So this stays only as a backstop against an absurd wallet — six figures of
 * pence — and is deliberately generous. It is a smell test, not a proof.
 */
const MAX_TEST_BALANCE_SATS = 10_000_000;

loadEnv();

async function main() {
  const args = process.argv.slice(2);
  const wantsMainnet = args.includes("--mainnet");
  const symbol = (args.find((a) => !a.startsWith("--")) ?? "").replace(/^\$/, "").toUpperCase();
  if (!symbol) {
    throw new Error("usage: npm run deploy -- '$SYMBOL' [--mainnet]");
  }

  const wif = process.env.PRIVATE_KEY;
  if (!wif) throw new Error("PRIVATE_KEY is not set. Run: npm run genkey");

  const key = bsv.PrivateKey.fromWIF(wif);
  const isMainnet = key.network.name === "livenet";

  // ⚠ MAINNET CANNOT HAPPEN BY ACCIDENT. The network comes from the KEY — so
  // it cannot be mismatched — and spending real money additionally requires
  // saying so on the command line. Two independent signals, one of them typed
  // deliberately every single time.
  if (isMainnet && !wantsMainnet) {
    throw new Error(
      "PRIVATE_KEY is a MAINNET key. Re-run with --mainnet if that is what you mean."
    );
  }
  if (!isMainnet && wantsMainnet) {
    throw new Error("--mainnet was passed but PRIVATE_KEY is a testnet key.");
  }

  const network = isMainnet ? bsv.Networks.mainnet : bsv.Networks.testnet;
  const address = key.toAddress(network).toString();

  /**
   * ⚠ `DefaultProvider` DIED MID-DEPLOY — `WhatsonchainProvider ERROR: socket
   * hang up` — after it had already broadcast a UTXO-preparation transaction.
   * That is the worst shape of failure: something went out and the response
   * was lost.
   *
   * `providerFor` broadcasts through GorillaPool's 1Sat endpoint, which is
   * the right choice here for the same reason `client-post.ts` already prefers
   * it: **an inscription that is mined but never indexed is, to every wallet
   * and marketplace, not an inscription.** Going through the ordinals endpoint
   * feeds the indexer directly instead of waiting for it to notice — and the
   * indexer is exactly what has to recognise this deploy for the test to mean
   * anything.
   */
  // ⚠ AND IT CARRIES A REAL FEE RATE. The stock provider reports 1 sat/kB,
  // which ARC refuses outright. See `provider.ts`.
  const provider = providerFor(network);

  if (isMainnet) {
    /**
     * ⚠ THE SPENDABLE SET, NOT `getBalance`. WhatsOnChain reports a 0-conf
     * parent AND the children that already spent it, so `getBalance` printed
     * 1,308,471 sats where 654,235 was real — it double-counted an
     * unconfirmed chain. `listUnspent` is what the transaction builder
     * itself selects from, so it is both the accurate number and the one
     * that matters.
     *
     * ⚠ AND IT DEGRADES RATHER THAN BLOCKING. If the endpoint is rate-limited
     * this check is skipped with a warning: it is a smell test, and refusing
     * to deploy because a courtesy lookup was throttled would be the guard
     * doing more harm than the thing it guards against.
     */
    let total: number | null = null;
    try {
      const utxos = await provider.listUnspent(key.toAddress(network));
      total = utxos.reduce((n, u) => n + u.satoshis, 0);
    } catch {
      console.log("⚠ Could not read the wallet (rate-limited?) — skipping the balance check.");
    }
    if (total !== null && total > MAX_TEST_BALANCE_SATS) {
      throw new Error(
        `Refusing to deploy from a wallet holding ${total.toLocaleString()} sats — well ` +
          `beyond what a test needs (ceiling ${MAX_TEST_BALANCE_SATS.toLocaleString()}). ` +
          "Check this is the key you meant; generate a fresh one if not."
      );
    }
    if (total === 0) {
      throw new Error(`No funds at ${address}. Send it ~2000 sats and try again.`);
    }
    // ⚠ THE ADDRESS IS THE REAL GUARD. Printed immediately before the spend,
    // in the one place somebody about to broadcast will read it.
    console.log("⚠ MAINNET — real money, and a deploy cannot be undone.");
    console.log(`  symbol   $${symbol}`);
    console.log(`  from     ${address}`);
    console.log(`  balance  ${total === null ? "unknown" : `${total.toLocaleString()} sats`}`);
    console.log("  Use a DISPOSABLE symbol — this is a test, and the supply is unrecoverable");
    console.log("  if the covenant is wrong.");
    console.log("");
  }

  PayToMint.loadArtifact();
  const signer = new TestWallet(key, provider);

  // The treasury is the deployer here. In production it is the platform
  // address, and it is FIXED AT DEPLOY — a treasury that could be repointed
  // later is a treasury the deployer can aim at themselves.
  const treasury = Addr(key.toAddress(network).toObject().hash as string);

  const instance = new PayToMint(
    // Genesis: BSV-21 assigns the id from this deploy's own outpoint, which
    // cannot be known before the transaction exists.
    toByteString(""),
    toByteString(symbol, true),
    MAX_SUPPLY,
    0n,
    treasury,
    BASE_PRICE
  );
  await instance.connect(signer);

  const explorer = isMainnet ? "https://whatsonchain.com" : "https://test.whatsonchain.com";

  /**
   * ⚠ A LOST RESPONSE IS NOT A FAILED BROADCAST, and a blind retry after one
   * is how you end up with two deploys of the same symbol. This already
   * happened: the provider hung up having successfully broadcast, and the only
   * way to know was to read the chain.
   */
  /**
   * ⚠ `deployToken()`, NOT `deploy(1)` — AND THE DIFFERENCE IS THE WHOLE THING.
   *
   * The first attempt called the generic `SmartContract.deploy(1)`, which
   * creates an output carrying the locking script and nothing else. It landed
   * (txid `5188220b…`, ~12,000 sats) and was **not a token**: GorillaPool
   * returned `Not Found` for `bsv20/id/<outpoint>` and saw an inscription only
   * on the change output. `deployToken()` prepends the BSV-21 `deploy+mint`
   * inscription with `Ordinal.createDeployV2` before deploying, and an indexer
   * keys on exactly that envelope, at the START of the script.
   *
   * This is the second time this project has paid to learn that **landing is
   * not being recognised** — the first was an inscription envelope built in
   * the wrong order, perfectly valid and completely invisible. Both were only
   * ever going to be caught by asking an indexer, which is why the verify step
   * is not optional.
   *
   * It returns the OUTPOINT, which is the token's permanent id.
   */
  let outpoint: string;
  try {
    outpoint = await instance.deployToken();
  } catch (e) {
    console.error("");
    console.error("Deploy failed — but a transaction MAY still have been broadcast.");
    console.error("CHECK THE CHAIN BEFORE RETRYING:");
    console.error(`  ${explorer}/address/${address}`);
    console.error("If a deploy transaction is there, use its txid; do not run this again.");
    console.error("");
    throw e;
  }

  const txid = outpoint.split("_")[0];
  console.log(`deployed  $${symbol}`);
  console.log(`  txid     ${txid}`);
  console.log(`  outpoint ${outpoint}`);
  console.log(`  treasury ${address}`);
  console.log(`  supply   ${MAX_SUPPLY} at ${BASE_PRICE} sats base`);
  console.log("");
  console.log("⚠ LANDING IS NOT THE SAME AS BEING RECOGNISED. Check both:");
  console.log(`  ${explorer}/tx/${txid}`);
  if (isMainnet) {
    console.log(`  https://ordinals.gorillapool.io/api/bsv20/id/${outpoint}`);
    console.log('  ⚠ the SECOND link is the one that matters — it must NOT say "Not Found".');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
