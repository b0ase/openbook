import { ImageResponse } from "next/og";
import { getPostById } from "@/app/actions";
import { titleCaseTicker } from "@/lib/ticker";

/**
 * The preview card a shared post unfurls into.
 *
 * ⚠ THE POST'S OWN WORDS, NOT THE SITE'S LOGO. Every permalink used to unfurl
 * into the same `og-openbooks.jpg` — so ten posts pasted into a Telegram group
 * were ten identical cards, and the image told a reader nothing about which one
 * they were being sent. On a board whose claim is *own what you post*, the
 * shared artefact carrying the platform's branding instead of the author's words
 * is exactly backwards.
 *
 * The description meta tag already carries the text for clients that read it,
 * but most feeds show the IMAGE first and some show only the image. This makes
 * the picture say what the post says.
 *
 * ⚠ RENDERED PER REQUEST, NOT AT BUILD. Posts arrive constantly and the id is
 * dynamic, so there is nothing to prerender; the DB read is the same one the
 * page itself does.
 */
export const dynamic = "force-dynamic";

export const alt = "A post on $OpenBooks";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * How much of the post fits on a card.
 *
 * ⚠ CUT IN JAVASCRIPT, NOT BY OVERFLOW. Satori will happily lay text out past
 * the bottom edge, so a long post would render a card whose last line is sliced
 * through the middle. An explicit ellipsis says "there is more" — a clipped
 * glyph says "this is broken".
 */
function excerpt(text: string, max = 260): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPostById(Number(id));

  const who = post?.author_nym ? `$${titleCaseTicker(post.author_nym)}` : (post?.author_name ?? "");
  const body = post ? excerpt(post.content) : "This post is no longer available.";
  // A long post gets smaller type rather than a shorter card — the alternative
  // is a fixed size that either wastes half the card on a one-liner or overruns
  // on a paragraph.
  const fontSize = body.length > 180 ? 40 : body.length > 90 ? 52 : 64;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#000000",
        padding: "64px 72px",
        // The one brand mark on the card: a gold edge, the same amber the site
        // uses for a claimed name.
        borderTop: "10px solid #f59e0b",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 30,
            color: post?.author_nym ? "#f59e0b" : "#a1a1aa",
            letterSpacing: "-0.01em",
          }}
        >
          {who}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize,
            lineHeight: 1.28,
            color: "#fafafa",
            letterSpacing: "-0.02em",
          }}
        >
          {body}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 26,
          color: "#52525b",
        }}
      >
        <div style={{ display: "flex" }}>openbooks.space</div>
        {/* Said on the card because it is the whole proposition, and because a
            stranger seeing this in a group chat has no other context for it. */}
        <div style={{ display: "flex" }}>Own what you post</div>
      </div>
    </div>,
    size
  );
}
