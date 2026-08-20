#!/usr/bin/env node

/**
 * Generate the platform's room-reading key.
 *
 * ⚠ THE TWO HALVES GO TO DIFFERENT PLACES, AND THAT SEPARATION IS THE WHOLE
 * SECURITY OF IT.
 *
 *   PUBLIC key  → `PLATFORM_ROOM_PUBKEY` in the deployment. Read at RUNTIME
 *                 on the server — NOT `NEXT_PUBLIC_`, which Next inlines at
 *                 build time and would be empty here, because the build runs
 *                 inside a Dockerfile with no deployment environment.
 *
 *   PRIVATE key → your own machine, offline, in a password manager. NOT in
 *                 Railway, NOT in .env, NOT in this repo.
 *
 * If the private half lives on the server, then a server compromise hands over
 * every private conversation on the platform at once — the deployment becomes a
 * honeypot whose value is the thing people paid tickets for. Kept offline, a
 * compromise gives an attacker nothing but the ability to seal posts TO you,
 * which is what everyone can already do.
 *
 * ⚠ AND IT CANNOT BE REPLACED LATER. Posts are sealed to the recipients named
 * at the moment they are inscribed, on a chain that cannot be rewritten. Lose
 * this key and every room sealed to it is unreadable by the platform FOREVER —
 * no reset, no recovery, and moderation of those rooms simply ends. Rotating to
 * a new key protects only posts written after the change.
 *
 *   node scripts/room-keygen.mjs
 */

import { PrivateKey } from "@bsv/sdk";

const key = PrivateKey.fromRandom();

console.log("");
console.log("  PLATFORM ROOM KEY");
console.log("  ─────────────────────────────────────────────────────────────");
console.log("");
console.log("  PUBLIC — put this in the deployment environment:");
console.log("");
console.log(`    PLATFORM_ROOM_PUBKEY=${key.toPublicKey().toString()}`);
console.log("");
console.log("  PRIVATE — store OFFLINE. Never deploy it. Never commit it.");
console.log("");
console.log(`    ${key.toWif()}`);
console.log("");
console.log("  ⚠ This is printed ONCE and is not recoverable.");
console.log("  ⚠ Lose it and every room sealed to it becomes permanently");
console.log("    unreadable by the platform — the chain cannot be rewritten.");
console.log("  ⚠ Rotating later protects only posts written AFTER the change.");
console.log("");
