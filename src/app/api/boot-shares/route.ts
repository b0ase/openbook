import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getServerAddress } from "@/services/bsv/wallet";
import { getBootPrice, getBootPriceForUser } from "@/services/fairness/pricing";
import { calculateSplit } from "@/services/fairness/split";
import { calculateWeights } from "@/services/fairness/weights";

export async function GET(req: NextRequest) {
  // Rate limit: 30 requests per minute per IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`boot-shares:${ip}`, { limit: 30, windowMs: 60_000 });
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = req.nextUrl;
  const postIdParam = searchParams.get("postId");
  const pubkey = searchParams.get("pubkey") ?? "";

  const postId = parseInt(postIdParam ?? "", 10);
  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "Invalid postId" }, { status: 400 });
  }

  // Validate the post exists and is boostable
  const post = db.prepare("SELECT id, pubkey FROM posts WHERE id = ?").get(postId) as
    | { id: number; pubkey: string | null }
    | undefined;

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  if (!post.pubkey) {
    return NextResponse.json({ error: "Post is unsigned — cannot be booted" }, { status: 422 });
  }

  // Require server wallet for split calculation — without it, platform share
  // has no valid destination address
  const platformAddress = getServerAddress();
  if (!platformAddress) {
    return NextResponse.json({ error: "Server wallet not configured" }, { status: 503 });
  }

  // Dynamic price — base price always needed even if this boot is free (server pays it)
  const basePrice = getBootPrice(db);
  const { price, isFree, freeRemaining } = pubkey
    ? getBootPriceForUser(db, pubkey)
    : { price: basePrice, isFree: false, freeRemaining: 0 };

  // The actual sats that will flow (free boots still cost the server the dynamic price)
  const effectivePrice = isFree ? basePrice : price;

  const weights = await calculateWeights(db);

  // Derive the boosted post creator's BSV address
  let creatorAddress: string;
  try {
    const { PublicKey } = await import("@bsv/sdk");
    creatorAddress = PublicKey.fromString(post.pubkey).toAddress().toString();
  } catch {
    return NextResponse.json({ error: "Invalid creator pubkey" }, { status: 422 });
  }

  const split = calculateSplit(
    effectivePrice,
    post.pubkey,
    creatorAddress,
    platformAddress,
    weights
  );

  // Flatten all recipient shares into a single list for the client
  const shares = [
    split.platform,
    ...(split.creatorBonus.sats > 0 ? [split.creatorBonus] : []),
    ...split.pool,
  ]
    .filter((r) => r.sats > 0)
    .map(({ address, sats, type }) => ({ address, sats, type }));

  return NextResponse.json({
    bootPrice: effectivePrice,
    isFree,
    freeRemaining,
    shares,
  });
}
