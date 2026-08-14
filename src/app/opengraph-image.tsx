import { ImageResponse } from "next/og";

/**
 * The social card. Generated rather than a checked-in PNG so the wordmark and the
 * positioning line can never drift from the app's.
 *
 * ⚠ NOTHING HERE MAY CLAIM THE TOKEN EXISTS. This image is the most-shared surface
 * the project has and the least able to be questioned back — the same rule the
 * manifesto and the agent prompt follow applies hardest here. It describes what is
 * live (posts on-chain, splits in one transaction) and names the fork's argument;
 * it does not say tokens are buyable, earnable or holdable, and it carries no
 * "get in early" framing.
 */

export const runtime = "nodejs";
export const alt = "$OpenBook — an open book of who built what";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#000000",
        padding: "72px 80px",
        borderLeft: "16px solid #f59e0b",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1,
          }}
        >
          <span style={{ color: "#f59e0b" }}>$Open</span>
          <span style={{ color: "#ffffff" }}>Book</span>
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 40,
            color: "#e4e4e7",
            letterSpacing: "-0.01em",
            lineHeight: 1.25,
          }}
        >
          An open book of who built what.
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 25,
            color: "#a1a1aa",
            lineHeight: 1.45,
            maxWidth: 900,
          }}
        >
          Every post anchored on-chain. Every boost split straight to contributors in a single
          transaction — no balances held, no IOUs.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", height: 1, background: "#27272a", marginBottom: 22 }} />
        <div style={{ display: "flex", fontSize: 23, color: "#f59e0b", lineHeight: 1.4 }}>
          Being paid for a contribution isn't the same as owning a piece of it.
        </div>
        <div style={{ display: "flex", marginTop: 10, fontSize: 20, color: "#71717a" }}>
          A fork of OpenCook
        </div>
      </div>
    </div>,
    size
  );
}
