import { type NextRequest, NextResponse } from "next/server";
import { hashTurn } from "@/lib/agent-record";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Attest that the platform's agent produced a given answer.
 *
 * ⚠ THIS IS THE ONLY PART OF A HUMAN/AI RECORD THAT PROVES ANYTHING ABOUT THE
 * AI. The hash chain in `lib/agent-record.ts` makes a published transcript
 * tamper-evident, but the poster computes it over text the poster supplies —
 * they can invent an answer and chain it perfectly. The server that ran the
 * model is the only party that knows what was actually returned, so its
 * signature is the only thing that can speak to it.
 *
 * ⚠ A SEPARATE KEY FROM THE WALLET, DELIBERATELY. `AGENT_ATTEST_WIF` is not
 * `BSV_SERVER_WIF`. An attestation key signs constantly and its compromise
 * costs credibility; the wallet key holds funds and its compromise costs money.
 * Signing with the spending key would put the high-value key on the hot path of
 * every agent reply for no benefit.
 *
 * Unset key = no attestation, and the caller MUST render that turn as an
 * unverified claim rather than failing closed into a false "verified" badge.
 */

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!rateLimit(`attest:${ip}`, { limit: 30, windowMs: 60_000 }).success) {
    return NextResponse.json({ error: "Slow down" }, { status: 429 });
  }

  let body: { prevHash?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = body.text;
  if (typeof text !== "string" || text.length === 0 || text.length > 20_000) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }
  const prevHash =
    typeof body.prevHash === "string" && /^[a-f0-9]{64}$/.test(body.prevHash)
      ? body.prevHash
      : null;

  const hash = hashTurn(prevHash, "agent", text);

  const wif = process.env.AGENT_ATTEST_WIF?.trim();
  if (!wif) {
    // Honest absence. The turn still chains; it is simply unattested, and the
    // client is expected to say so rather than imply verification.
    return NextResponse.json({ hash, attested: false });
  }

  try {
    const { PrivateKey } = await import("@bsv/sdk");
    const key = PrivateKey.fromWif(wif);
    const signature = key.sign(Array.from(new TextEncoder().encode(hash))).toDER("hex") as string;
    return NextResponse.json({
      hash,
      attested: true,
      signature,
      pubkey: key.toPublicKey().toString(),
    });
  } catch {
    // A misconfigured key must not fail the exchange — the answer is already
    // in front of the user. Degrade to unattested.
    console.error("[OpenBooks] agent attest: invalid AGENT_ATTEST_WIF");
    return NextResponse.json({ hash, attested: false });
  }
}
