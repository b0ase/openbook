import { ImageResponse } from "next/og";
import { getThreadStats, resolveTickers } from "@/app/actions";
import { canonicalTicker, isValidTicker, titleCaseTicker } from "@/lib/ticker";

/**
 * The social card for a shared ticker link, e.g. `/api/og?p=$openbook/$test`.
 *
 * ⚠ A ROUTE, NOT A `opengraph-image.tsx` FILE, AND IT HAS TO BE. The ticker page
 * is the catch-all `[...ticker]`, and Next refuses a metadata file inside a
 * catch-all segment — `Catch-all must be the last part of the URL in route
 * "/[...ticker]/opengraph-image"` is a BUILD failure, not a warning. So the page
 * points `openGraph.images` here instead. Do not try to reintroduce the file.
 *
 * ⚠ THIS IS THE CARD THAT ACTUALLY GETS SHARED. A ticker URL is the addressable
 * form of an idea — what someone pastes into a chat to say "look at this" — so
 * without it every such link previewed as the generic site card and the idea
 * being pointed at was invisible. `app/opengraph-image.tsx` still covers `/`.
 *
 * ⚠ THE LINE IS TOKEN vs MARKET (TOKENS.md). This card MAY say tokens exist and
 * are owned by whoever posted — live and true. It may NOT say they are buyable,
 * sellable or worth money, and carries no "get in early" framing. This surface is
 * the least able to be questioned back, so the rule applies hardest here.
 *
 * Falls back to a name-only card if the DB read fails: a card without stats beats
 * a broken preview, and card generation must never take a page down.
 */

export const runtime = "nodejs";

const SIZE = { width: 1200, height: 630 };

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("p") ?? "";
  // Same parse as the page: `$`-prefixed segments only, canonicalised, invalid
  // ones dropped rather than rendered — a hand-edited URL must not put arbitrary
  // text on something that looks like an official card.
  const path = raw
    .split("/")
    .filter((seg) => seg.startsWith("$"))
    .map((seg) => canonicalTicker(decodeURIComponent(seg)))
    .filter(isValidTicker);

  const leaf = path.at(-1);
  let replies = 0;
  let tokens = 0;
  let found = false;

  if (leaf) {
    try {
      const rootId = (await resolveTickers([leaf]))[leaf]?.root_id;
      if (rootId) {
        found = true;
        const stats = await getThreadStats(rootId);
        replies = stats.replies;
        tokens = stats.tokens;
      }
    } catch {
      // Name-only card; see the header note.
    }
  }

  const display = path.length ? path.map((s) => `$${titleCaseTicker(s)}`) : ["$OpenBook"];
  const name = display.at(-1) ?? "$OpenBook";

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
        {/* Ancestry above the name, dimmed — context, not the subject, exactly as
            the thread header renders it. */}
        {display.length > 1 && (
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: "#71717a",
              letterSpacing: "-0.01em",
              marginBottom: 14,
            }}
          >
            {display.slice(0, -1).join(" / ")}
          </div>
        )}
        <div
          style={{
            display: "flex",
            fontSize: name.length > 14 ? 78 : 104,
            fontWeight: 700,
            color: "#f59e0b",
            letterSpacing: "-0.03em",
            lineHeight: 1,
          }}
        >
          {name}
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 30,
            fontSize: 34,
            color: "#e4e4e7",
            letterSpacing: "-0.01em",
            lineHeight: 1.3,
            maxWidth: 940,
          }}
        >
          {found
            ? "An idea on $OpenBook, anchored on-chain and owned by the people who wrote it."
            : "An idea on $OpenBook. This name is unclaimed — post it and it's yours."}
        </div>

        {found && (
          <div style={{ display: "flex", marginTop: 34, gap: 56 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 52, fontWeight: 700, color: "#ffffff" }}>
                {tokens}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: "#a1a1aa", marginTop: 4 }}>
                {tokens === 1 ? "token issued" : "tokens issued"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 52, fontWeight: 700, color: "#ffffff" }}>
                {replies}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: "#a1a1aa", marginTop: 4 }}>
                {replies === 1 ? "reply" : "replies"}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", height: 1, background: "#27272a", marginBottom: 22 }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" }}>
            <span style={{ color: "#f59e0b" }}>$Open</span>
            <span style={{ color: "#ffffff" }}>Book</span>
          </div>
          <div style={{ display: "flex", fontSize: 21, color: "#71717a" }}>
            Post it. It's yours.
          </div>
        </div>
      </div>
    </div>,
    {
      ...SIZE,
      headers: {
        // Cards are re-fetched by every scraper that sees the link, and the
        // numbers move slowly. Short cache, long stale window.
        "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      },
    }
  );
}
