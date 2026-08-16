"use client";

import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { MediaEmbed, YouTubeEmbed } from "@/components/MediaEmbed";
import { identityColor, identityTextColor } from "@/lib/identity-color";
import { findUrls } from "@/lib/linkify";
import { firstMedia, storedNameFromUrl } from "@/lib/media";
import { titleCaseTicker } from "@/lib/ticker";
import { timeAgo } from "@/lib/utils";
import { firstYouTube } from "@/lib/youtube";
import type { Post } from "@/types";
import { PostText } from "./PostText";

/**
 * A post's rendered body — author line, content, link preview.
 *
 * Extracted from `PostList` so the thread view renders posts identically to the
 * feed. The pieces that differ BETWEEN the two (the unread observer, the Genesis
 * badge, the boot button column, the `<article>` wrapper itself) deliberately
 * stay with their caller; only what must look the same lives here.
 *
 * `badge` is a slot for a caller-supplied chip beside the author name — the feed
 * passes the Genesis marker, the thread view passes nothing.
 */
export function PostContent({
  post,
  badge,
  onOpenTicker,
  tickerSupply,
  attachmentNames,
}: {
  post: Post;
  badge?: React.ReactNode;
  /** Open the thread a `$Ticker` names. Omitted = tickers render as plain text. */
  onOpenTicker?: (symbol: string) => void;
  /** Tokens issued per ticker — see PostText. */
  tickerSupply?: Record<string, number>;
  /**
   * Original filenames for uploads, keyed by stored name.
   *
   * Resolved in bulk by the feed rather than per card, because a lookup per post
   * would turn scrolling into a query storm. Absent entries are normal — an
   * upload predating provenance has no name — and the card falls back to its
   * generic label rather than showing a hash.
   */
  attachmentNames?: Record<string, string>;
}) {
  const urls = findUrls(post.content).map((u) => u.url);
  const media = firstMedia(urls);
  // A YouTube link has no file extension, so it is invisible to `firstMedia`
  // and used to fall through to the unfurl card — a thumbnail of a video you
  // then had to leave the board to watch.
  const youtube = media ? null : firstYouTube(urls);
  // ⚠ When the post is NOTHING BUT the media link, the URL is not content — it
  // is plumbing, and printing a 100-character hash above the player is the
  // reason an uploaded video reads as "not surfaced". The text is suppressed
  // only in that exact case: any caption around the link is still the author's
  // writing and must survive.
  const embedded = media?.url ?? youtube?.url ?? null;
  const isBareMedia = embedded !== null && post.content.trim() === embedded;

  // Seed the author's colour on the pubkey, falling back to the generated
  // handle only for unsigned genesis posts that have no key. Seeding on the
  // NAME would recolour an author's entire history the moment they claimed a
  // $Nym — see the warning in identity-color.ts.
  const authorSeed = post.pubkey ?? post.author_name;

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        {/* A claimed $Nym IS the author's name — it replaces the generated
            anon_xxxx handle rather than sitting beside it. Amber marks it as a
            claimed name (the same treatment tickers get everywhere else), which
            is also what distinguishes it from an unclaimed handle at a glance. */}
        {post.author_nym ? (
          <span className="font-medium" style={{ color: identityColor(authorSeed) }}>
            ${titleCaseTicker(post.author_nym)}
          </span>
        ) : (
          <span className="font-medium" style={{ color: identityColor(authorSeed) }}>
            {post.author_name}
          </span>
        )}
        {badge}
        {post.signature && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block shrink-0"
            title="Signed"
          />
        )}
        <span>·</span>
        <time suppressHydrationWarning>{timeAgo(post.created_at)}</time>
        {post.tx_id && (
          <a
            href={`https://whatsonchain.com/tx/${post.tx_id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="View on chain"
            className="relative -m-3 p-3 inline-flex items-center text-emerald-500 hover:text-emerald-400 transition-colors"
          >
            <span className="sr-only">View on chain</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </a>
        )}
      </div>
      {!isBareMedia && (
        <p
          className="mt-1.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: identityTextColor(authorSeed) }}
        >
          <PostText
            content={post.content}
            onOpenTicker={onOpenTicker}
            tickerSupply={tickerSupply}
          />
        </p>
      )}
      {/* A direct media link is SHOWN; anything else falls through to the unfurl
          card. Both never render for the same post — a media file is not HTML, so
          the unfurl records `not_html` and the card declines to draw. */}
      {media ? (
        <MediaEmbed
          url={media.url}
          kind={media.kind}
          label={attachmentNames?.[storedNameFromUrl(media.url) ?? ""]}
        />
      ) : youtube ? (
        <YouTubeEmbed id={youtube.id} />
      ) : (
        <LinkPreviewCard post={post} />
      )}
    </>
  );
}
