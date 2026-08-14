/**
 * Full boot workflow coordinator.
 * Validates → prices → scores → splits → broadcasts → records.
 * SQLite bootboard only updates AFTER successful BSV broadcast.
 */

import type BetterSqlite3 from "better-sqlite3";
import {
  getBalance,
  getServerAddress,
  isServerSpendDisabled,
  SERVER_FEE_BUFFER_SATS,
} from "@/services/bsv/wallet";
import { buildSplitTransaction } from "./boot-payment";
import { FAIRNESS_CONFIG } from "./config";
import { getBootPrice, getBootPriceForUser } from "./pricing";
import { calculateSplit } from "./split";
import { calculateWeights } from "./weights";

export interface BootResult {
  success: boolean;
  txid?: string;
  price: number;
  recipients: number;
  error?: string;
  isFree: boolean;
  // The broadcast TIMED OUT — the boot MAY have landed on-chain. Terminal: the
  // grant is already consumed and is NOT refunded, and the caller MUST NOT retry
  // (a retry rebuilds a new tx → the server double-pays). See Phase 2 Build A.
  indeterminate?: boolean;
}

// Build B: proactive low-balance alert. Greppable console warning when the server
// wallet drops below the alert threshold — fires BEFORE the wallet is empty so the
// operator has runway to top up. Alert-only (never blocks a boot). Debounced to
// avoid spamming on a burst. Real alerting (webhook/email) is a Phase 5 follow-up.
let _lastLowBalanceAlertAt = 0;
function maybeAlertLowBalance(spendableSats: number): void {
  if (spendableSats >= FAIRNESS_CONFIG.serverLowBalanceAlertSats) return;
  const now = Date.now();
  if (now - _lastLowBalanceAlertAt < 5 * 60_000) return; // debounce: once per 5 min
  _lastLowBalanceAlertAt = now;
  console.warn(
    `[OpenCook ALERT] Server wallet low: ${spendableSats} sats spendable (< ${FAIRNESS_CONFIG.serverLowBalanceAlertSats}). Free boots route to paid once a boot can't be covered. Top up the BSV_SERVER_WIF address.`
  );
}

/**
 * Execute a full boot: validate, price, score, split, broadcast, record.
 *
 * @param booterAddress  Stable identifier for the booter (BSV address) — used for boot_grants tracking
 * @param booterName    Human-readable name (e.g. anon_x4f2) — stored in bootboard for display
 */
export async function executeBoot(
  db: BetterSqlite3.Database,
  postId: number,
  booterAddress: string,
  booterName: string
): Promise<BootResult> {
  // 1. Validate the post exists and is boostable (has pubkey)
  const post = db.prepare("SELECT id, pubkey, author_name FROM posts WHERE id = ?").get(postId) as
    | { id: number; pubkey: string | null; author_name: string }
    | undefined;

  if (!post)
    return { success: false, price: 0, recipients: 0, error: "Post not found", isFree: false };
  if (!post.pubkey)
    return {
      success: false,
      price: 0,
      recipients: 0,
      error: "Post is unsigned — cannot be booted",
      isFree: false,
    };

  // 2. Server wallet must be configured — it is the payout source.
  const platformAddress = getServerAddress();

  // 3. Get dynamic price and check free boot eligibility
  const { price, isFree } = getBootPriceForUser(db, booterAddress);
  // Free boots pay the floor (1,000 sats), not the dynamic price.
  // Bounds per-user server subsidy at ~15,690 sats regardless of platform scale.
  // See DECISIONS.md "Free boots pay floor only (settled 2026-04-09)".
  const actualPrice = isFree ? FAIRNESS_CONFIG.bootPriceFloor : price;

  // Finding 4 (deep audit 2026-06-15): refuse when the server wallet is
  // unconfigured. Mirrors the 503 in boot-shares/boot-confirm — with no
  // platformAddress there is no payout destination, so a "boot" here would burn
  // a free-boot grant and record a phantom bootboard row while paying NO ONE
  // (the Step-8 consume below is NOT gated on platformAddress). Refuse BEFORE the
  // consume so nothing is spent and no phantom boot is recorded.
  if (!platformAddress) {
    return {
      success: false,
      price: actualPrice,
      recipients: 0,
      error: "SERVER_WALLET_UNCONFIGURED",
      isFree,
    };
  }

  // 4. Calculate contribution weights
  const weights = await calculateWeights(db);

  // 5. Derive boosted post creator's address from their pubkey
  let creatorAddress: string;
  try {
    const { PublicKey } = await import("@bsv/sdk");
    creatorAddress = PublicKey.fromString(post.pubkey).toAddress().toString();
  } catch {
    return {
      success: false,
      price: actualPrice,
      recipients: 0,
      error: "Invalid creator pubkey",
      isFree,
    };
  }

  // 7. Step 8 — free-boot idempotency. Consume the grant ATOMICALLY, BEFORE the
  //    broadcast, so a crash between a successful broadcast (server wallet has
  //    paid) and the DB record can't let a retry make the server pay twice. The
  //    monotonic `free_boots_used` counter IS the idempotency key — server-built
  //    free boots have no client txid to key on. The SELECT + UPDATE run inside
  //    one synchronous better-sqlite3 transaction, so a concurrent free boot
  //    (double-click / two tabs) can't both pass the check (closes the TOCTOU
  //    between bootPost's price read and this consume).
  //    Accepted tradeoff (DECISIONS.md "Free-boot path consumes the grant BEFORE
  //    paying"): a broadcast failure AFTER consume loses the user one free boot —
  //    NOT refunded, because a broadcast failure is ambiguous (the tx may already
  //    be in the mempool, so a refund could re-open the double-pay). Server-wallet
  //    protection > one free boot. Deliberately reverses the old C5 bias for this
  //    server-funded path (SECURITY_AUDIT.md C5).
  if (isFree) {
    // Build C: kill-switch. If server spending is disabled, route free boots to
    // PAID BEFORE consuming the grant (so tripping the switch never strands a
    // grant). Paid/client boots are unaffected — they spend the user's own funds.
    // Fail-closed by design: when tripped, the server simply stops spending.
    if (isServerSpendDisabled()) {
      console.warn(
        `OpenCook: server spending DISABLED — routing free boot for post ${postId} to paid`
      );
      return {
        success: false,
        price: getBootPrice(db),
        recipients: 0,
        error: "SERVER_SPEND_DISABLED",
        isFree: false,
      };
    }

    // Build B: pre-consume balance precheck. NEVER consume a free grant for a boot
    // the server can't pay. Read the spendable balance; if it can't cover price +
    // fee, route to PAID (client-funded) BEFORE consuming the grant. Fails toward
    // PAID — a WoC read failure reads low → paid, never fail-open into a doomed
    // broadcast that would burn the grant (the old dry-wallet bug). Also emits the
    // proactive low-balance alert. See DECISIONS.md "Dry server wallet routes free
    // boots to paid" + Phase 2 Build B.
    const spendable = await getBalance();
    maybeAlertLowBalance(spendable);
    if (spendable < actualPrice + SERVER_FEE_BUFFER_SATS) {
      console.warn(
        `OpenCook: server wallet can't cover free boot for post ${postId} (${spendable} < ${actualPrice + SERVER_FEE_BUFFER_SATS} sats) — routing to paid`
      );
      return {
        success: false,
        price: getBootPrice(db),
        recipients: 0,
        error: "SERVER_WALLET_LOW",
        isFree: false,
      };
    }

    const consumed = db.transaction(() => {
      const row = db
        .prepare("SELECT free_boots_used FROM boot_grants WHERE pubkey = ?")
        .get(booterAddress) as { free_boots_used: number } | undefined;
      const used = row?.free_boots_used ?? 0;
      if (used >= FAIRNESS_CONFIG.freeBootsPerUser) return false;
      if (row) {
        db.prepare(
          "UPDATE boot_grants SET free_boots_used = free_boots_used + 1 WHERE pubkey = ?"
        ).run(booterAddress);
      } else {
        db.prepare(
          "INSERT INTO boot_grants (pubkey, free_boots_used, total_boots) VALUES (?, 1, 0)"
        ).run(booterAddress);
      }
      return true;
    })();
    if (!consumed) {
      // The grant was exhausted concurrently between bootPost's check and here.
      // Route to PAID rather than spend the server wallet (fail toward paid).
      return {
        success: false,
        price: getBootPrice(db),
        recipients: 0,
        error: "FREE_GRANT_EXHAUSTED",
        isFree: false,
      };
    }
  }

  // 8. Calculate the split
  let txid: string | undefined;
  let recipientCount = 0;
  let split: ReturnType<typeof calculateSplit> | null = null;

  if (platformAddress) {
    split = calculateSplit(actualPrice, post.pubkey, creatorAddress, platformAddress, weights);
    recipientCount = split.recipientCount;

    // 7. Build and broadcast the BSV split transaction
    const result = await buildSplitTransaction(split, postId, booterAddress);

    if (result.status === "success") {
      txid = result.txid;
    } else {
      // A broadcast TIMEOUT is indeterminate (the tx may have landed); any other
      // status means it definitively did not broadcast. Both are terminal here.
      const indeterminate = result.status === "broadcast_timeout";
      const errorDetail = result.status === "broadcast_failed" ? result.error : result.status;
      console.error(
        `OpenCook: boot split broadcast ${indeterminate ? "TIMED OUT (indeterminate)" : "FAILED"} for post ${postId}: ${errorDetail}`
      );
      // Step 8: the free grant was ALREADY consumed before this broadcast and is
      // deliberately NOT refunded here — a broadcast failure/timeout is ambiguous
      // (the tx may have reached the mempool), so refunding could re-open the
      // double-pay. The user loses one free boot; the server pays at most once
      // (the accepted tradeoff in DECISIONS.md "consume the grant BEFORE paying").
      return {
        success: false,
        price: actualPrice,
        recipients: 0,
        error: indeterminate
          ? "Boost submitted but not yet confirmed"
          : `Broadcast failed: ${errorDetail}`,
        isFree,
        indeterminate,
      };
    }
  }

  // 8. Update SQLite (bootboard + grants + payouts).
  // For free boots this block is only reached when platformAddress is set AND broadcast succeeded (txid defined).
  // For unconfigured-wallet boots (no platformAddress) we still record the bootboard entry — no grant to consume.
  db.transaction(() => {
    // Close current bootboard holder
    db.prepare(`
      UPDATE bootboard SET held_until = datetime('now')
      WHERE held_until IS NULL
    `).run();

    // New post takes the spot.
    // boosted_by = BSV address (used for activity feed queries by address)
    // boosted_by_name = human-readable display name (anon_XXXX)
    // is_free = 1 when the server wallet paid (user had a free boot grant)
    const bootboardInsert = db
      .prepare(`
      INSERT INTO bootboard (post_id, boosted_by, boosted_by_name, is_free) VALUES (?, ?, ?, ?)
    `)
      .run(postId, booterAddress, booterName, isFree ? 1 : 0);

    // Use the unique bootboard row ID as bootEventId so multiple boots on the
    // same post each get their own payout set — prevents double-counting in earnings.
    const bootEventId = bootboardInsert.lastInsertRowid as number;

    // total_boots counts every delivered boot. `free_boots_used` for free boots
    // was already consumed BEFORE the broadcast (Step 8), so it is NOT touched
    // here — this block only records the delivered boot. The grant row already
    // exists for free boots (the pre-broadcast consume created/updated it).
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

    // Record payouts for audit trail (when split transaction was broadcast)
    if (split && txid) {
      if (split.platform.sats > 0) {
        db.prepare(
          "INSERT INTO payouts (boot_event_id, recipient_pubkey, recipient_address, amount_sats, payout_type, txid) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          bootEventId,
          "platform",
          split.platform.address,
          split.platform.sats,
          "platform",
          txid
        );
      }

      if (split.creatorBonus.sats > 0) {
        db.prepare(
          "INSERT INTO payouts (boot_event_id, recipient_pubkey, recipient_address, amount_sats, payout_type, txid) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          bootEventId,
          split.creatorBonus.pubkey,
          split.creatorBonus.address,
          split.creatorBonus.sats,
          "boost_bonus",
          txid
        );
      }

      for (const recipient of split.pool) {
        if (recipient.sats > 0) {
          db.prepare(
            "INSERT INTO payouts (boot_event_id, recipient_pubkey, recipient_address, amount_sats, payout_type, txid) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(
            bootEventId,
            recipient.pubkey,
            recipient.address,
            recipient.sats,
            "pool_share",
            txid
          );
        }
      }
    }
  })();

  return {
    success: true,
    txid,
    price: actualPrice,
    recipients: recipientCount,
    isFree,
  };
}
