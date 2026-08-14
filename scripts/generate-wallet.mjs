/**
 * Generate a new BSV keypair for the server wallet.
 * Run: node scripts/generate-wallet.mjs
 *
 * Copy the WIF into your .env.local as BSV_SERVER_WIF
 * Fund the address with a small amount of BSV (10,000 sats covers thousands of posts)
 */

const { PrivateKey } = await import("@bsv/sdk");

const key = PrivateKey.fromRandom();
const wif = key.toWif();
const address = key.toPublicKey().toAddress().toString();

console.log("");
console.log("=== OpenBook Server Wallet ===");
console.log("");
console.log("WIF (add to .env.local as BSV_SERVER_WIF):");
console.log(wif);
console.log("");
console.log("Address (fund this with BSV):");
console.log(address);
console.log("");
console.log("Even 10,000 sats (~$0.005) covers thousands of OP_RETURN posts.");
console.log("");
