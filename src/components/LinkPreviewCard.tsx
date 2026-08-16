"use client";

import { useState } from "react";
import type { Post } from "@/types";

/**
 * The unfurled link card under a post.
 *
 * Renders nothing unless the unfurl succeeded AND produced something worth
 * showing. Three states collapse to null deliberately:
 *   - no link in the post                → all fields null
 *   - unfurl not landed yet              → all fields null (it is fire-and-forget)
 *   - unfurl failed or found no metadata → status set, title null
 *
 * A bare card showing only a hostname is worse than no card, so the bar for
 * rendering is a title.
 */
/**
 * Takes any row carrying the preview fields, not a whole `Post`.
 *
 * Widened so the Boost Board's spotlight can render the same card as the feed:
 * it has a `BootboardRow`, which is a different shape with the identical preview
 * columns. A structural type is what stops that becoming a second card component
 * that drifts from this one.
 */
type Previewable = Pick<
  Post,
  | "preview_url"
  | "preview_title"
  | "preview_description"
  | "preview_image"
  | "preview_site_name"
  | "preview_status"
>;

export function LinkPreviewCard({ post }: { post: Previewable }) {
  // ⚠ A THIRD-PARTY og:image THAT 404s MUST NOT RENDER A BROKEN IMAGE. Sites
  // advertise images that do not exist (bitcoinchat.online does exactly this), and
  // images rot long after a post is written — but the post is permanent, so the
  // card has to survive the image outliving it. A broken-image icon reads as OUR
  // failure, so the card degrades to text instead.
  const [imageFailed, setImageFailed] = useState(false);

  if (post.preview_status !== "ok" || !post.preview_title || !post.preview_url) return null;

  let host = "";
  try {
    host = new URL(post.preview_url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }

  return (
    <a
      href={post.preview_url}
      target="_blank"
      // ⚠ noopener is load-bearing, not boilerplate: without it the opened page
      // gets a window.opener handle back into this tab and can navigate it.
      rel="noopener noreferrer nofollow ugc"
      className="mt-2 flex overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70"
    >
      {post.preview_image && !imageFailed && (
        <div className="hidden h-[84px] w-[84px] shrink-0 bg-zinc-900 sm:block">
          {/* biome-ignore lint/performance/noImgElement: next/image is the WRONG
              tool here, not merely unnecessary. OG images come from arbitrary
              third-party hosts, so using it needs `remotePatterns: hostname: '**'`
              — which turns the image optimizer into an open proxy anyone can
              point at any URL, spending our bandwidth and optimization quota.
              A plain <img> with no-referrer and lazy loading is the safer trade;
              the cost is an unoptimised thumbnail in a 84px box. */}
          <img
            src={post.preview_image}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="min-w-0 flex-1 px-3 py-2">
        <div className="truncate text-[11px] text-zinc-500">{post.preview_site_name || host}</div>
        <div className="mt-0.5 line-clamp-2 text-[13px] font-medium leading-snug text-zinc-200">
          {post.preview_title}
        </div>
        {post.preview_description && (
          <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-zinc-400">
            {post.preview_description}
          </div>
        )}
      </div>
    </a>
  );
}
