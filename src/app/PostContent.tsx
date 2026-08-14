"use client";

import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { MediaEmbed } from "@/components/MediaEmbed";
import { findUrls } from "@/lib/linkify";
import { firstMedia } from "@/lib/media";
import { timeAgo } from "@/lib/utils";
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
}: {
  post: Post;
  badge?: React.ReactNode;
  /** Open the thread a `$Ticker` names. Omitted = tickers render as plain text. */
  onOpenTicker?: (symbol: string) => void;
}) {
  const media = firstMedia(findUrls(post.content).map((u) => u.url));

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-300">{post.author_name}</span>
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
      <p className="mt-1.5 text-[15px] leading-relaxed text-zinc-200 whitespace-pre-wrap break-words">
        <PostText content={post.content} onOpenTicker={onOpenTicker} />
      </p>
      {/* A direct media link is SHOWN; anything else falls through to the unfurl
          card. Both never render for the same post — a media file is not HTML, so
          the unfurl records `not_html` and the card declines to draw. */}
      {media ? <MediaEmbed url={media.url} kind={media.kind} /> : <LinkPreviewCard post={post} />}
    </>
  );
}
