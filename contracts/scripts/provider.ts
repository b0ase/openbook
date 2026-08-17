import {
  type AddressOption,
  bsv,
  Provider,
  type TransactionResponse,
  type TxHash,
  type UTXO,
} from "scrypt-ts";

/**
 * The provider these scripts use: WhatsOnChain for reads, GorillaPool for the
 * broadcast, and nothing else in the way.
 *
 * ⚠ WRITTEN BECAUSE THE BUNDLED PROVIDERS FAILED THREE DIFFERENT WAYS on three
 * consecutive real deploys, none of them in the contract:
 *
 *  1. **`DefaultProvider.getFeePerKb()` returns 1.** Measured, not inferred. One
 *     satoshi per kilobyte, far under any miner's floor, so every transaction
 *     carried a 1-satoshi fee. WhatsOnChain's relay accepted it; GorillaPool's
 *     ARC refused — *"arc error 465: fee too low, minimum expected 38, actual 1"*.
 *  2. **`OrdiProvider.connect()` retries into the wall.** It delegates to
 *     `DefaultProvider`, and on failure calls the same probe again immediately,
 *     inside the catch, with no backoff — so one `429 Too Many Requests`
 *     reliably becomes two and the deploy dies at a preflight.
 *  3. **`WhatsonchainProvider` throws `connect failed: Timeout of 3000ms` from a
 *     floating promise**, which escapes `main().catch()` and prints a raw stack.
 *     Three seconds on a public endpoint is optimistic; leaking the rejection
 *     means it cannot even be caught.
 *
 * All three are plumbing rather than the covenant, and all three come from
 * provider machinery doing more than it was asked to. This does the three things
 * these scripts actually need — list UTXOs, broadcast, read a transaction — with
 * no fan-out, no probe, and patient timeouts.
 *
 * ⚠ BROADCAST GOES TO THE ORDINALS ENDPOINT FIRST, for the reason
 * `client-post.ts` already prefers it: **an inscription that is mined but never
 * indexed is, to every wallet and marketplace, not an inscription.** GorillaPool
 * feeds its own indexer, and that indexer recognising this deploy is the entire
 * point of the exercise. WhatsOnChain is the fallback — a relay that accepts the
 * bytes beats nothing, but it does not feed the indexer, so a deploy that only
 * lands there still has to be checked.
 */

/**
 * ⚠ DELIBERATELY GENEROUS. The app runs at 110 sat/kB (measured: ARC's floor was
 * 100). ARC wanted 38 satoshis for the deploy, and 110 sat/kB yields almost
 * exactly 38 — passing by rounding is not passing. These scripts run by hand a
 * handful of times, so a fee that is too low costs a failed broadcast and a
 * confusing error, while one that is too high costs about two thousandths of a
 * US cent. `post-economics.ts` reads the live policy instead, because it pays on
 * every post and the difference compounds. Here it does not.
 */
const SCRIPT_FEE_PER_KB = 500;

/** Public endpoints are slow before they are broken. 3s was not patience. */
const TIMEOUT_MS = 20_000;

async function get(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class ScriptProvider extends Provider {
  private network: bsv.Networks.Network;

  constructor(network: bsv.Networks.Network) {
    super();
    this.network = network;
    // Some paths inside the tx builder read this global rather than asking
    // the provider; a mismatch only ever shows up as a rejected broadcast.
    (bsv.Transaction as unknown as { FEE_PER_KB: number }).FEE_PER_KB = SCRIPT_FEE_PER_KB;
  }

  private get base(): string {
    const net = this.network === bsv.Networks.mainnet ? "main" : "test";
    return `https://api.whatsonchain.com/v1/bsv/${net}`;
  }

  /**
   * ⚠ NO PREFLIGHT. There is nothing to verify — no API key, no session — so a
   * probe can only invent failures, which is exactly what it did twice. The
   * three operations below each report their own, at the moment the network is
   * genuinely needed.
   */
  connect(): Promise<this> {
    this.emit("connected", true);
    return Promise.resolve(this);
  }

  isConnected(): boolean {
    return true;
  }

  updateNetwork(network: bsv.Networks.Network): void {
    this.network = network;
    this.emit("networkChange", network);
  }

  getNetwork(): bsv.Networks.Network {
    return this.network;
  }

  getFeePerKb(): Promise<number> {
    return Promise.resolve(SCRIPT_FEE_PER_KB);
  }

  async listUnspent(address: AddressOption): Promise<UTXO[]> {
    const addr = address.toString();
    const res = await get(`${this.base}/address/${addr}/unspent`);
    if (!res.ok) throw new Error(`listUnspent failed: ${res.status} ${res.statusText}`);
    const rows = (await res.json()) as Array<{
      height: number;
      tx_pos: number;
      tx_hash: string;
      value: number;
    }>;

    const script = bsv.Script.fromAddress(addr).toHex();
    return (
      rows
        // ⚠ NEVER SPEND A 1-SATOSHI OUTPUT. On this chain that is an ordinal
        // — somebody's post, or a contract's own state output. `OrdiProvider`
        // filters the same way and it is not optional: paying a fee out of an
        // inscription destroys it.
        .filter((u) => u.value > 1)
        .map((u) => ({
          txId: u.tx_hash,
          outputIndex: u.tx_pos,
          satoshis: u.value,
          script,
        }))
    );
  }

  async getBalance(address?: AddressOption): Promise<{ confirmed: number; unconfirmed: number }> {
    if (!address) return { confirmed: 0, unconfirmed: 0 };
    // ⚠ SUMMED FROM THE SPENDABLE SET, not WhatsOnChain's balance endpoint.
    // That one reports a 0-conf parent AND the children that already spent
    // it, which printed 1,308,471 sats where 654,235 was real.
    const utxos = await this.listUnspent(address);
    return { confirmed: utxos.reduce((n, u) => n + u.satoshis, 0), unconfirmed: 0 };
  }

  async getTransaction(txHash: TxHash): Promise<TransactionResponse> {
    const res = await get(`${this.base}/tx/${txHash}/hex`);
    if (!res.ok) throw new Error(`getTransaction failed: ${res.status} ${res.statusText}`);
    return new bsv.Transaction(await res.text()) as unknown as TransactionResponse;
  }

  async sendRawTransaction(rawTxHex: string): Promise<TxHash> {
    const errors: string[] = [];

    // Ordinals endpoint FIRST — see the note at the top of this file.
    try {
      const res = await fetch("https://ordinals.gorillapool.io/api/tx/bin", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(rawTxHex, "hex"),
      });
      const body = (await res.text()).trim().replace(/^"|"$/g, "");
      if (res.ok && /^[a-f0-9]{64}$/i.test(body)) return body;
      errors.push(`gorillapool: ${res.status} ${body.slice(0, 300)}`);
    } catch (e) {
      errors.push(`gorillapool: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const res = await fetch(`${this.base}/tx/raw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txhex: rawTxHex }),
      });
      const body = (await res.text()).trim().replace(/^"|"$/g, "");
      if (res.ok && /^[a-f0-9]{64}$/i.test(body)) return body;
      errors.push(`whatsonchain: ${res.status} ${body.slice(0, 300)}`);
    } catch (e) {
      errors.push(`whatsonchain: ${e instanceof Error ? e.message : String(e)}`);
    }

    throw new Error(`broadcast failed —\n  ${errors.join("\n  ")}`);
  }
}

/** The provider for a given network. */
export function providerFor(network: bsv.Networks.Network): ScriptProvider {
  return new ScriptProvider(network);
}
