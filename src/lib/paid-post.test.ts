/**
 * Paid-post verification.
 *
 * The server is handed these bytes by the person who profits from them, so every
 * test here is an attack: inscribe one thing and store another, own the post
 * with someone else's key, underpay the platform, hand over garbage.
 */

import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { buildInscriptionScript, INSCRIPTION_SATS } from "@/services/bsv/inscription";
import { verifyPaidPost } from "./paid-post";

const authorKey = PrivateKey.fromRandom();
const AUTHOR = authorKey.toPublicKey().toAddress().toString();
const PLATFORM = PrivateKey.fromRandom().toPublicKey().toAddress().toString();
const OTHER = PrivateKey.fromRandom().toPublicKey().toAddress().toString();

function build(opts: {
  content: string;
  owner?: string;
  platformSats?: number;
  platformTo?: string;
  omitInscription?: boolean;
}): string {
  const tx = new Transaction();
  if (opts.omitInscription) {
    tx.addOutput({ lockingScript: new P2PKH().lock(AUTHOR), satoshis: 1 });
  } else {
    tx.addOutput({
      lockingScript: buildInscriptionScript({
        address: opts.owner ?? AUTHOR,
        contentType: "application/json",
        data: Array.from(
          new TextEncoder().encode(JSON.stringify({ app: "openbooks", content: opts.content }))
        ),
      }),
      satoshis: INSCRIPTION_SATS,
    });
  }
  if (opts.platformSats !== undefined) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(opts.platformTo ?? PLATFORM),
      satoshis: opts.platformSats,
    });
  }
  return tx.toHex();
}

const base = { authorAddress: AUTHOR, platformAddress: PLATFORM, minPlatformSats: 50 };

describe("verifyPaidPost", () => {
  it("accepts a correctly built post and DERIVES the txid from the bytes", () => {
    const rawTx = build({ content: "hello world", platformSats: 50 });
    const v = verifyPaidPost({ ...base, rawTx, content: "hello world" });

    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Derived, never accepted — so there is no claimed txid to substitute.
    expect(v.txid).toBe(Transaction.fromHex(rawTx).id("hex"));
    expect(v.vout).toBe(0);
  });

  it("REJECTS inscribing one thing and storing another", () => {
    // The attack this whole module exists for: the chain record and the board
    // would disagree, and the chain record is the one we tell people to trust.
    const rawTx = build({ content: "what I inscribed", platformSats: 50 });
    const v = verifyPaidPost({ ...base, rawTx, content: "what I want stored" });
    expect(v).toEqual({ ok: false, reason: "content_mismatch" });
  });

  it("REJECTS an inscription owned by somebody else", () => {
    // If the author cannot spend it, they do not own their post.
    const rawTx = build({ content: "mine", owner: OTHER, platformSats: 50 });
    const v = verifyPaidPost({ ...base, rawTx, content: "mine" });
    expect(v).toEqual({ ok: false, reason: "wrong_owner" });
  });

  it("REJECTS an underpaid platform fee", () => {
    const rawTx = build({ content: "cheapskate", platformSats: 49 });
    const v = verifyPaidPost({ ...base, rawTx, content: "cheapskate" });
    expect(v).toEqual({ ok: false, reason: "platform_underpaid" });
  });

  it("REJECTS a fee paid to the wrong address", () => {
    const rawTx = build({ content: "misdirected", platformSats: 500, platformTo: OTHER });
    const v = verifyPaidPost({ ...base, rawTx, content: "misdirected" });
    expect(v).toEqual({ ok: false, reason: "platform_underpaid" });
  });

  it("accepts OVERpayment — the floor is a minimum, not an exact price", () => {
    // boot-confirm learned this expensively: recomputing an exact amount
    // rejected legitimate drift, and the client retry double-paid.
    const rawTx = build({ content: "generous", platformSats: 5_000 });
    expect(verifyPaidPost({ ...base, rawTx, content: "generous" }).ok).toBe(true);
  });

  it("sums multiple outputs to the platform", () => {
    // ⚠ BUILT FRESH, NOT PARSED-THEN-MUTATED. `Transaction.fromHex(...)` followed
    // by `addOutput(...)` and `toHex()` SILENTLY DROPS the added output in
    // @bsv/sdk 2.x — the re-serialized hex parses back with the original output
    // count. Harmless here (production always builds fresh), but any future code
    // that edits a parsed transaction would lose money outputs without an error.
    const tx = new Transaction();
    tx.addOutput({
      lockingScript: buildInscriptionScript({
        address: AUTHOR,
        contentType: "application/json",
        data: Array.from(
          new TextEncoder().encode(JSON.stringify({ app: "openbooks", content: "split" }))
        ),
      }),
      satoshis: INSCRIPTION_SATS,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(PLATFORM), satoshis: 30 });
    tx.addOutput({ lockingScript: new P2PKH().lock(PLATFORM), satoshis: 25 });

    expect(verifyPaidPost({ ...base, rawTx: tx.toHex(), content: "split" }).ok).toBe(true);
  });

  it("REJECTS a transaction with no inscription at all", () => {
    const rawTx = build({ content: "n/a", omitInscription: true, platformSats: 50 });
    const v = verifyPaidPost({ ...base, rawTx, content: "n/a" });
    expect(v).toEqual({ ok: false, reason: "no_inscription" });
  });

  it("REJECTS garbage rather than throwing", () => {
    for (const rawTx of ["", "not hex", "deadbeef", "00".repeat(50)]) {
      const v = verifyPaidPost({ ...base, rawTx, content: "x" });
      expect(v.ok).toBe(false);
    }
  });

  it("skips the fee check when at-cost posting is configured", () => {
    // platformAddress null = no markup expected; a post with no fee output is
    // then legitimate rather than underpaid.
    const rawTx = build({ content: "free ride" });
    const v = verifyPaidPost({
      rawTx,
      content: "free ride",
      authorAddress: AUTHOR,
      platformAddress: null,
      minPlatformSats: 0,
    });
    expect(v.ok).toBe(true);
  });
});
