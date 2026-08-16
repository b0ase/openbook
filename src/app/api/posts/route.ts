import { type NextRequest, NextResponse } from "next/server";
import {
  getBootboard,
  getNewPosts,
  getPostCounts,
  getPostPreviews,
  getPosts,
  getUpdatedPosts,
} from "@/app/actions";
import { maybeRunAgentTick } from "@/lib/agent-tick";
import { CLIENT_BUILD_ID } from "@/lib/build-id";
import { rateLimit } from "@/lib/rate-limit";
import { sweepOrphans } from "@/services/bsv/anchor-sweep";
import { sweepPreviews } from "@/services/link-preview-sweep";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = rateLimit(`posts:${ip}`, { limit: 120, windowMs: 60_000 });
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Ambient clock for the durable anchor sweep — drains any un-anchored post so
  // the "every post on-chain" invariant holds without a dedicated worker.
  // Fire-and-forget, single-flight (no-op if a sweep is already running).
  void sweepOrphans();
  // Same ambient pattern as the sweep: this app has no worker, so the agent
  // runtime rides on traffic the site already gets. Single-flight and interval
  // limited inside — see maybeRunAgentTick, which spends money when it fires.
  maybeRunAgentTick();
  // Backfill previews for seeded/imported posts, which never went through
  // createPost and so were never unfurled. One network fetch per sweep.
  void sweepPreviews();

  const sinceIdParam = request.nextUrl.searchParams.get("since_id");
  const sinceId = sinceIdParam !== null ? parseInt(sinceIdParam, 10) : null;
  // Client sends IDs of posts it has that are missing tx_id (chain icon)
  const pendingTxParam = request.nextUrl.searchParams.get("pending_tx");

  const pendingIds: number[] = pendingTxParam
    ? pendingTxParam.split(",").map(Number).filter(Number.isFinite).slice(0, 100)
    : [];

  // Client sends IDs of confirmed visible posts it wants live boot counts for
  const countsParam = request.nextUrl.searchParams.get("counts");
  const countIds: number[] = countsParam
    ? countsParam.split(",").map(Number).filter(Number.isFinite).slice(0, 100)
    : [];

  // Client sends IDs of posts that carry a link but whose unfurl had not landed
  // when it received them — see getPostPreviews for why nothing else re-fetches
  // those rows.
  const previewsParam = request.nextUrl.searchParams.get("previews");
  const previewIds: number[] = previewsParam
    ? previewsParam.split(",").map(Number).filter(Number.isFinite).slice(0, 50)
    : [];

  const [posts, bootboard, updated, counts, previews] = await Promise.all([
    sinceId !== null && Number.isFinite(sinceId) && sinceId >= 0
      ? getNewPosts(sinceId)
      : getPosts(),
    getBootboard(),
    pendingIds.length > 0 ? getUpdatedPosts(pendingIds) : Promise.resolve([]),
    countIds.length > 0 ? getPostCounts(countIds) : Promise.resolve([]),
    previewIds.length > 0 ? getPostPreviews(previewIds) : Promise.resolve([]),
  ]);

  // The running build. Lets an open tab notice it is older than the server
  // (see lib/build-id.ts) — carried on the poll the feed already makes rather
  // than a second request, so detection costs nothing.
  return NextResponse.json({
    posts,
    bootboard,
    updated,
    counts,
    previews,
    buildId: CLIENT_BUILD_ID,
  });
}
