"use client";

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
export function LinkPreviewCard({ post }: { post: Post }) {
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
      {post.preview_image && (
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
