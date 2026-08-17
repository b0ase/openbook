# Contracts

The on-chain half of the token model: a **pay-to-mint covenant** that holds a
ticker's unissued supply in a contract UTXO and releases units only when the
spending transaction pays the required price.

## Why this is a separate workspace

⚠ **The sCrypt toolchain must never enter the Next.js build.** It pulls a
compiler binary and a second Bitcoin library (`scrypt-ts` does not use
`@bsv/sdk`), and the app's build is already tuned around Turbopack, the React
Compiler and a set of node-polyfill shims. One `import` from `src/` into here
would drag all of it into a bundle that ships to browsers.

So: own `package.json`, own `node_modules` (gitignored — the root rule is
anchored and would not have caught it), and excluded from the app's `tsconfig`
so `next build` never type-checks it.

Nothing in `src/` imports from this directory. What crosses the boundary is
**data** — a deployed contract's outpoint and its parameters — never code.

## Why this exists at all

Today `$Ticker` units are rows in `ticker_holdings`. Real money is charged for
them and the post that names a word is genuinely inscribed, but the units
themselves are a database ledger — which means the platform is trusted to apply
transfers, and TOKENS.md is explicit that this is a real assumption rather than
a trustless one.

A pay-to-mint covenant removes it: the supply lives in a script, the price is
enforced by the script, and a mint is valid because the chain says so.

## Status

**Nothing here touches the live app.** No contract is deployed on any chain yet,
so `$Ticker` units remain a database ledger.

### Testing happens on MAINNET, by the owner's decision (2026-08-17)

Both testnet faucets were dead for him, and his call was: *"just do the tests on
main-net — and if needs be discard the tests when it's time to do the real
thing."* At these amounts that is a reasonable trade: a deploy is ~200 sats and
a mint 113, so an iteration costs a fraction of a cent.

⚠ **The risk was never losing money.** A covenant bug is not a thrown error — it
permanently locks a token's entire unissued supply in a UTXO nobody can ever
spend. So the symbol used for testing must be **disposable**, and thrown away
before any real word is deployed. The order is unchanged: local tests → deploy a
throwaway → confirm an indexer sees deploy, mint and transfer → only then
anything real.

### Guards

- **The network comes from the KEY**, never a flag, so it cannot be mismatched.
- **Mainnet additionally requires `--mainnet`** typed on the command line. Two
  independent signals, one of them deliberate every time.
- **A deploy refuses any wallet holding more than 50,000 sats.** A test key
  should be nearly empty; that ceiling exists to catch the worst plausible
  mistake — pasting the platform's own `BSV_SERVER_WIF` in here. It must never
  be used for this.
- **`genkey` refuses to overwrite an existing `.env`.** Running it twice would
  orphan whatever the old key holds, including a deployed contract.
- The WIF is never printed. Only the address is.

## Running it

```sh
npm test                              # compiles, then runs the covenant tests

npm run genkey -- --mainnet           # writes .env, prints an address to fund
# send that address ~2000 sats from your own wallet — NOT the server key
npm run deploy -- '$TESTMINT1' --mainnet
npm run mint   -- <deploy-txid> 1 --mainnet
```

`npm test` compiles before it runs, deliberately: a stale artifact would
silently test a different script from the one on disk.
