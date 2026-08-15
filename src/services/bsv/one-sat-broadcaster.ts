/**
 * Broadcast through GorillaPool's ORDINALS endpoint rather than plain ARC.
 *
 * ⚠ WHY THIS EXISTS: an inscription is only useful once an indexer has ingested
 * it. ARC hands the transaction to miners and the ordinals indexer picks it up
 * from the chain afterwards; this endpoint feeds that indexer directly. Both
 * routes are GorillaPool and both get the transaction mined — the difference is
 * how quickly (and how certainly) the post shows up as an ordinal.
 *
 * Reimplemented from `js-1sat-ord`'s `oneSatBroadcaster` rather than adding the
 * dependency: the whole thing is one POST, and pulling in a library that also
 * carries its own transaction building, UTXO fetching and marketplace helpers
 * would put a second, differently-opinionated money path beside the audited one.
 *
 * The wire format is theirs and must be matched exactly:
 *   POST https://ordinals.gorillapool.io/api/tx
 *   { "rawtx": "<base64 of the raw transaction>" }
 * with the txid returned as the response body.
 *
 * ⚠ BASE64, NOT HEX. Everything else in this codebase moves transactions as hex,
 * so this is the one place that conversion matters — sending hex here fails in a
 * way that looks like a rejected transaction rather than a formatting mistake.
 */

import type { Broadcaster, BroadcastFailure, BroadcastResponse, Transaction } from "@bsv/sdk";
import { Utils } from "@bsv/sdk";

export const ONE_SAT_BROADCAST_URL = "https://ordinals.gorillapool.io/api/tx";

/**
 * Map the endpoint's reply onto the SDK's result shape.
 *
 * Split out from the request so the mapping is tested without a network — this
 * is the part that decides whether the caller thinks money moved.
 */
export function mapOneSatResponse(
  ok: boolean,
  status: number,
  body: unknown
): BroadcastResponse | BroadcastFailure {
  if (ok) {
    // The body IS the txid. Validated rather than trusted: a proxy or error page
    // returning 200 with HTML would otherwise be recorded as a successful
    // broadcast and stored as a post's permanent identity.
    const txid = typeof body === "string" ? body.trim() : "";
    if (!/^[a-f0-9]{64}$/i.test(txid)) {
      return {
        status: "error",
        code: "BAD_TXID",
        description: "Broadcast returned 200 but no transaction id",
      };
    }
    return { status: "success", txid, message: "broadcast successful" };
  }

  const description =
    (typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : typeof body === "string"
        ? body
        : "") || "Broadcast rejected";

  return { status: "error", code: String(status || "ERR_UNKNOWN"), description };
}

export function oneSatBroadcaster(): Broadcaster {
  return {
    async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
      try {
        const res = await fetch(ONE_SAT_BROADCAST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ rawtx: Utils.toBase64(tx.toBinary()) }),
        });

        // The endpoint answers with a bare txid on success, which is not JSON —
        // so read text first and only try to parse when it failed.
        const text = await res.text();
        let body: unknown = text;
        if (!res.ok) {
          try {
            body = JSON.parse(text);
          } catch {
            /* keep the raw text as the description */
          }
        }
        return mapOneSatResponse(res.ok, res.status, body);
      } catch (e) {
        return {
          status: "error",
          code: "NETWORK",
          description: e instanceof Error ? e.message : "Broadcast failed",
        };
      }
    },
  };
}
