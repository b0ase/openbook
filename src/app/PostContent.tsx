"use client";

import { useState } from "react";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { MediaEmbed, YouTubeEmbed } from "@/components/MediaEmbed";
import { identityColor, identityTextColor } from "@/lib/identity-color";
import { findUrls } from "@/lib/linkify";
import { firstMedia, storedNameFromUrl } from "@/lib/media";
import { postHref, postUrl } from "@/lib/post-href";
import { shouldFold } from "@/lib/post-length";
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
  /**
   * Long posts fold in the feed.
   *
   * There is no length LIMIT any more (posting is paid and priced by size — see
   * `post-length.ts`), which makes very long posts possible and therefore makes
   * folding necessary: one of them between two short posts hides everything
   * after it, so the fold protects OTHER people's posts more than the reader.
   */
  const expandable = shouldFold(post.content);
  const [expanded, setExpanded] = useState(false);
  const folded = expandable && !expanded;
  const [copied, setCopied] = useState(false);

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
        {/* ⚠ THE TIMESTAMP IS THE PERMALINK, the way it is on X. A post had no
            URL of its own, so the only way to reach one was to scroll a feed to
            it — unshareable, on a board whose claim is that what you wrote is
            yours. The timestamp is the conventional place to put it and costs no
            new chrome. `PostList`'s row-click guard already treats an `<a>` as
            interactive, so this opens the permalink rather than the thread
            overlay. */}
        <a
          href={postHref(post.id)}
          className="transition-colors hover:text-zinc-300"
          title="Permalink to this post"
        >
          <time suppressHydrationWarning>{timeAgo(post.created_at)}</time>
        </a>
        {/* ⚠ THE PERMALINK NEEDS TO BE VISIBLE, not just present. It existed on
            the timestamp — the convention X uses — and the owner still reported
            that a post "has no unique URL", because a date in the same grey as
            the rest of the line announces nothing, and on a touch screen there
            is no hover to discover it with. A control you cannot see is a
            control you do not have. Copying beats navigating here: the reason
            to want a post's address is almost always to paste it somewhere. */}
        <button
          type="button"
          onClick={() => {
            /**
             * ⚠ NEVER CLAIM A COPY THAT DID NOT HAPPEN, and never fail silently
             * either. Clipboard writes are refused on insecure origins, in some
             * in-app WebViews, and whenever the document is not focused — and
             * `navigator.clipboard` is simply ABSENT in others, which is why
             * this is not written as one optional-chained promise chain: `?.`
             * would short-circuit past the `.catch` and leave the button doing
             * nothing at all. A control that does nothing visible would
             * recreate the very problem it exists to fix, so every failure
             * falls back to OPENING the permalink, which puts the address in
             * the bar where it can be copied by hand.
             */
            const fallback = () => {
              window.location.href = postHref(post.id);
            };
            const clipboard = navigator.clipboard;
            if (!clipboard?.writeText) {
              fallback();
              return;
            }
            clipboard
              .writeText(postUrl(window.location.origin, post.id))
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(fallback);
          }}
          title="Copy link to this post"
          className={`relative -m-3 p-3 inline-flex items-center transition-colors ${
            copied ? "text-amber-400" : "text-zinc-600 hover:text-zinc-300"
          }`}
        >
          <span className="sr-only">Copy link to this post</span>
          {copied ? (
            <svg
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
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg
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
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <path d="M16 6l-4-4-4 4" />
              <path d="M12 2v14" />
            </svg>
          )}
        </button>
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
        <>
          <p
            className={`mt-1.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${
              folded ? "line-clamp-[12]" : ""
            }`}
            style={{ color: identityTextColor(authorSeed) }}
          >
            <PostText
              content={post.content}
              onOpenTicker={onOpenTicker}
              tickerSupply={tickerSupply}
            />
          </p>
          {/* ⚠ CLAMPED, NOT TRUNCATED. The whole text stays in the DOM and only
              its height is capped, so Find-in-page, screen readers, copy-paste
              and selection all still reach the words a reader paid to have kept
              forever. Slicing the string would make the feed quietly disagree
              with what is on-chain.

              A `<button>`, which `PostList`'s row-click guard already treats as
              interactive — so expanding a post cannot also open its thread. */}
          {expandable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[12px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
            >
              {folded ? "Show more" : "Show less"}
            </button>
          )}
        </>
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
