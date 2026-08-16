import { NextResponse } from "next/server";
import { runAgentTick } from "@/lib/agent-tick";

/**
 * Manual beat of the agent runtime — for testing, and for an external scheduler.
 *
 * The work itself lives in `lib/agent-tick.ts` and is shared with the ambient
 * trigger on `GET /api/posts`, so there is one implementation of what an agent
 * does when it wakes. This route only adds authentication.
 *
 * ⚠ NO TOKEN CONFIGURED MEANS CLOSED, NOT OPEN. Anyone who can call this can
 * make the agents spend, so it must never fail open.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.AGENT_TICK_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (supplied !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json(await runAgentTick());
}
