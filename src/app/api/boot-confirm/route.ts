import { type NextRequest, NextResponse } from "next/server";
import { bootConfirmMessage } from "@/lib/boot-message";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { broadcastTx } from "@/services/bsv/broadcast";
import { getServerAddress } from "@/services/bsv/wallet";
import { FAIRNESS_CONFIG } from "@/services/fairness/config";

interface BootConfirmBody {
  postId: number;
  txid: string;
  rawTx?: string;
  booterPubkey: string; // hex compressed pubkey — VERIFIED; the credited address is derived from it
  signature: string; // DER hex over bootConfirmMessage(postId, txid)
  booterName: string;
}

export async function POST(req: NextRequest) {
  let body: BootConfirmBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { postId, txid, rawTx, booterPubkey, signature, booterName } = body;

  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "Invalid postId" }, { status: 400 });
  }
  if (typeof txid !== "string" || txid.trim().length === 0) {
    return NextResponse.json({ error: "Missing txid" }, { status: 400 });
  }

  // Validate txid format: must be exactly 64 hex characters
  if (!/^[a-fA-F0-9]{64}$/.test(txid.trim())) {
    return NextResponse.json({ error: "Invalid txid format" }, { status: 400 });
  }

  // Rate limit: 10 confirmations per minute per IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`boot-confirm:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Replay protection: reject if this txid was already recorded
  const existingPayout = db
    .prepare("SELECT id FROM payouts WHERE txid = ? LIMIT 1")
    .get(txid.trim()) as { id: number } | undefined;
  if (existingPayout) {
    return NextResponse.json({ error: "Transaction already recorded" }, { status: 409 });
  }

  // Authenticate the booter: verify an ECDSA signature over the canonical boot
  // message and DERIVE the credited address from the verified pubkey. This binds
  // the boot record to the key that signed it, so a client cannot forge
  // `boosted_by` (boot-attribution forgery / framing). Matches the createPost
  // signature pattern. Fails closed (401) before any DB write or re-broadcast.
  // See SECURITY_AUDIT.md C3 / Step 7. NOTE: this does NOT defend the narrow
  // mempool-race where an attacker re-submits a victim's already-broadcast tx
  // under the attacker's OWN key to self-credit (the victim's later confirm then
  // 409s) — that requires winning a sub-second race against the victim's
  // synchronous confirm and only yields self-credit, not framing. Tracked.
  if (typeof booterPubkey !== "string" || booterPubkey.trim().length === 0) {
    return NextResponse.json({ error: "Missing booterPubkey" }, { status: 400 });
  }
  if (typeof signature !== "string" || signature.trim().length === 0) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }
  let booterAddress: string;
  try {
    const { PublicKey, Signature } = await import("@bsv/sdk");
    const message = bootConfirmMessage(postId, txid);
    const messageBytes = Array.from(new TextEncoder().encode(message));
    const pk = PublicKey.fromString(booterPubkey.trim());
    const verified = pk.verify(messageBytes, Signature.fromDER(signature.trim(), "hex"));
    if (!verified) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    booterAddress = pk.toAddress().toString();
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Verify the transaction by parsing the raw tx hex sent by the client.
  // The tx bytes are self-authenticating: txid = hash(bytes), so a forged
  // rawTx produces a different txid and fails the binding check below.
  // This removes the dependency on WhatsOnChain indexing (which has 5-30s+
  // propagation lag from ARC and can rate-limit the server).
  if (typeof rawTx !== "string" || rawTx.trim().length === 0) {
    return NextResponse.json({ error: "Missing rawTx" }, { status: 400 });
  }
  if (!/^[a-fA-F0-9]+$/.test(rawTx.trim()) || rawTx.trim().length % 2 !== 0) {
    return NextResponse.json({ error: "Invalid rawTx format" }, { status: 400 });
  }

  interface ParsedVout {
    sats: number;
    address: string | null;
  }
  let txVouts: ParsedVout[] = [];
  try {
    const { Transaction, Utils } = await import("@bsv/sdk");
    const OP_DUP = 0x76;
    const OP_HASH160 = 0xa9;
    const OP_EQUALVERIFY = 0x88;
    const OP_CHECKSIG = 0xac;
    const parsed = Transaction.fromHex(rawTx.trim());

    // Bind rawTx to claimed txid — prevents substitution attacks
    const parsedTxid = parsed.id("hex") as string;
    if (parsedTxid !== txid.trim()) {
      return NextResponse.json({ error: "rawTx does not match txid" }, { status: 400 });
    }

    // Server re-broadcasts the signed tx via ARC as an idempotent safety net.
    // If the client's broadcast succeeded, ARC returns code 257 "already known"
    // (still success — tx is in mempool). If the client's broadcast silently
    // failed, ARC accepts the fresh submission. Either way, past this point
    // the tx is GUARANTEED in ARC's mempool — eliminates phantom recordings.
    const broadcast = await broadcastTx(parsed);
    const bcResult = broadcast as {
      status?: string | number;
      code?: string | number;
      description?: string;
    };
    const bcCode = String(bcResult.code ?? "").trim();
    const bcDesc = (bcResult.description ?? "").toLowerCase();
    const bcAlreadyKnown =
      broadcast.status !== "success" &&
      bcCode !== "258" &&
      !bcDesc.includes("conflict") &&
      (bcCode === "257" ||
        /\balready[- ]known\b/.test(bcDesc) ||
        bcDesc.includes("already in the mempool"));

    if (broadcast.status !== "success" && !bcAlreadyKnown) {
      if (bcCode === "258" || bcDesc.includes("conflict") || bcDesc.includes("missing inputs")) {
        console.warn(
          `[OpenBook] boot-confirm: TX_CONFLICT for ${txid.slice(0, 16)}… — ${bcDesc || bcCode}`
        );
        return NextResponse.json(
          {
            error: "Transaction conflicts with chain (inputs already spent)",
            code: "TX_CONFLICT",
          },
          { status: 409 }
        );
      }
      console.warn(
        `[OpenBook] boot-confirm: ARC_UNAVAILABLE for ${txid.slice(0, 16)}… — ${bcDesc || bcCode}`
      );
      return NextResponse.json(
        { error: "Could not confirm broadcast, please retry", code: "ARC_UNAVAILABLE" },
        { status: 503 }
      );
    }

    // Extract (sats, address) from each output by matching P2PKH locking scripts.
    // Inspect chunks directly — P2PKH.lock() builds { op: 20, data } for the push,
    // which toASM() can render inconsistently across SDK versions.
    txVouts = parsed.outputs.map((out) => {
      const sats = out.satoshis ?? 0;
      let address: string | null = null;
      try {
        const chunks = out.lockingScript.chunks;
        if (
          chunks.length === 5 &&
          chunks[0].op === OP_DUP &&
          chunks[1].op === OP_HASH160 &&
          chunks[2].op === 20 &&
          chunks[2].data?.length === 20 &&
          chunks[3].op === OP_EQUALVERIFY &&
          chunks[4].op === OP_CHECKSIG
        ) {
          // toBase58Check defaults prefix=[0x00] (mainnet) and prepends it to
          // `bin`. Pass raw 20-byte hash, NOT versioned bytes, to avoid the
          // double-prefix that produces 35-char "11..." addresses.
          address = Utils.toBase58Check(chunks[2].data);
        }
      } catch {
        /* non-P2PKH output (e.g. OP_RETURN) — no address */
      }
      return { sats, address };
    });
  } catch (err) {
    console.error("[OpenBook] boot-confirm: rawTx parse failed", err);
    return NextResponse.json({ error: "Could not parse rawTx" }, { status: 400 });
  }

  // booterName defaults to the server-derived booterAddress if not provided
  const displayName =
    typeof booterName === "string" && booterName.trim().length > 0
      ? booterName.trim()
      : booterAddress;

  // Validate the post exists and has a pubkey (so we can pay the creator)
  const post = db.prepare("SELECT id, pubkey FROM posts WHERE id = ?").get(postId) as
    | { id: number; pubkey: string | null }
    | undefined;

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  if (!post.pubkey) {
    return NextResponse.json({ error: "Post is unsigned — cannot be booted" }, { status: 422 });
  }

  const platformAddress = getServerAddress();
  if (!platformAddress) {
    return NextResponse.json({ error: "Server wallet not configured" }, { status: 503 });
  }

  // Finding 6 (deep audit 2026-06-15): the tx is self-authenticating
  // (hash(rawTx)===txid, verified above) and has already been re-broadcast into
  // ARC's mempool — the money has MOVED. RECORD what was actually paid on-chain;
  // do NOT recompute a fresh split and reject on mismatch. The pool weights/price
  // legitimately drift between the boot-shares quote and this confirm (every other
  // boot mutates bootboard → weights; a new post moves the price), and a
  // mismatch-reject would 400 an ALREADY-BROADCAST tx → the client retries →
  // a NEW txid double-pays (the replay guard at the top is txid-only).
  let creatorAddress: string;
  try {
    const { PublicKey } = await import("@bsv/sdk");
    creatorAddress = PublicKey.fromString(post.pubkey).toAddress().toString();
  } catch {
    return NextResponse.json({ error: "Invalid creator pubkey" }, { status: 422 });
  }

  // Sum on-chain sats per recipient address (the OP_RETURN output is non-P2PKH →
  // address null → naturally excluded).
  const onChainByAddr = new Map<string, number>();
  for (const vout of txVouts) {
    if (vout.address) {
      onChainByAddr.set(vout.address, (onChainByAddr.get(vout.address) ?? 0) + vout.sats);
    }
  }

  // CONSERVATION FLOOR — the one enforced invariant: the platform must receive at
  // least its floor-based cut. The platform address is the server wallet, NEVER
  // the booter, so this can't false-reject. Using the FLOOR (not the drift-prone
  // recomputed price) keeps it a fixed lower bound the client knows in advance, so
  // legitimate price/weight drift never trips it. Prevents recording a boot that
  // paid the platform ~nothing. ACCEPTED RESIDUAL: a client can under-pay the
  // *non-platform* contributors and still get a boot recorded — but that's their
  // own money, contributors are credited exactly what was sent on-chain (honest
  // ledger), and a per-contributor floor is impossible because the booter can
  // themselves be a pool recipient (it would false-reject a solo contributor).
  const minPlatform = Math.floor(FAIRNESS_CONFIG.bootPriceFloor * FAIRNESS_CONFIG.platformCut) - 2;
  const platformPaid = onChainByAddr.get(platformAddress) ?? 0;
  if (platformPaid < minPlatform) {
    console.warn(
      `[OpenBook] boot-confirm: platform underpaid — got ${platformPaid}, min ${minPlatform}, txid ${txid.slice(0, 16)}…`
    );
    return NextResponse.json(
      { error: "Transaction does not meet the minimum boot payout", code: "BOOT_UNDERPAID" },
      { status: 422 }
    );
  }

  // Payout rows are built FROM the parsed on-chain outputs. The booter's change
  // (P2PKH back to booterAddress) is excluded. recipient_pubkey is just an audit
  // label — earnings joins on recipient_address (DECISIONS.md "Money surfaces key
  // on the BSV address"), so "" is fine for chain-derived pool recipients.
  const chainPayouts = txVouts
    .filter((v) => v.address && v.address !== booterAddress && v.sats > 0)
    .map((v) => {
      const address = v.address as string;
      if (address === platformAddress) {
        return { address, sats: v.sats, payoutType: "platform", recipientPubkey: "platform" };
      }
      if (address === creatorAddress) {
        return {
          address,
          sats: v.sats,
          payoutType: "boost_bonus",
          recipientPubkey: post.pubkey as string,
        };
      }
      return { address, sats: v.sats, payoutType: "pool_share", recipientPubkey: "" };
    });

  // All SQLite writes wrapped in a single transaction
  db.transaction(() => {
    // Close the current bootboard holder
    db.prepare(`
      UPDATE bootboard SET held_until = datetime('now')
      WHERE held_until IS NULL
    `).run();

    // Insert the new bootboard entry.
    // boosted_by = BSV address (used for activity feed queries by address)
    // boosted_by_name = human-readable display name (anon_XXXX)
    const bootboardInsert = db
      .prepare(`
      INSERT INTO bootboard (post_id, boosted_by, boosted_by_name) VALUES (?, ?, ?)
    `)
      .run(postId, booterAddress, displayName);

    // Use the unique bootboard row ID as bootEventId so multiple boots on the
    // same post each get their own payout set — prevents double-counting in earnings.
    const bootEventId = bootboardInsert.lastInsertRowid as number;

    // Update or create boot_grants (paid boot — increment total_boots only)
    const existing = db
      .prepare("SELECT pubkey FROM boot_grants WHERE pubkey = ?")
      .get(booterAddress);

    if (existing) {
      db.prepare("UPDATE boot_grants SET total_boots = total_boots + 1 WHERE pubkey = ?").run(
        booterAddress
      );
    } else {
      db.prepare(
        "INSERT INTO boot_grants (pubkey, free_boots_used, total_boots) VALUES (?, 0, 1)"
      ).run(booterAddress);
    }

    // Record payouts FROM the verified on-chain outputs (Finding 6) — the earnings
    // ledger reflects what was actually paid, not a recomputed (drift-prone) split.
    for (const p of chainPayouts) {
      db.prepare(
        "INSERT INTO payouts (boot_event_id, recipient_pubkey, recipient_address, amount_sats, payout_type, txid) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(bootEventId, p.recipientPubkey, p.address, p.sats, p.payoutType, txid);
    }
  })();

  return NextResponse.json({ success: true });
}
