"use client";

import { useState } from "react";
import { isSelfHostedMedia, type MediaKind } from "@/lib/media";
import { youTubeEmbedUrl } from "@/lib/youtube";

/**
 * Inline player for a post that links directly at an image, video or audio file.
 *
 * ⚠ EVERY EMBED DEGRADES TO A LINK. The URL is third-party and the post is
 * permanent, so the file WILL eventually 404, move, or be pulled. When that
 * happens the post must still make sense — a dead player is worse than the plain
 * link the reader could have clicked.
 *
 * `preload="none"` on video and audio is not a micro-optimisation: a feed can hold
 * a hundred posts, and letting each one reach out to a stranger's server on render
 * would make simply scrolling into a burst of outbound requests, plus a bandwidth
 * bill for whoever hosts the file.
 *
 * No autoplay, ever. Media that plays itself in a feed is hostile, and on mobile
 * it is also a data charge the reader did not agree to.
 */
/**
 * A YouTube video, played in place.
 *
 * ⚠ `loading="lazy"` is doing the same job `preload="none"` does for a raw
 * video file: a feed can hold a hundred posts, and framing every one of them on
 * render would fire a hundred requests at YouTube before the reader had scrolled
 * to any of them.
 *
 * The framed host is `youtube-nocookie.com` (see `youTubeEmbedUrl`) and the
 * sandbox is the narrowest set that still lets a video play — notably WITHOUT
 * `allow-top-navigation`, so a framed page cannot redirect the reader away from
 * the board.
 */
export function YouTubeEmbed({ id }: { id: string }) {
  return (
    <div className="mt-2 aspect-video w-full overflow-hidden rounded-lg border border-zinc-800 bg-black">
      <iframe
        src={youTubeEmbedUrl(id)}
        title="YouTube video"
        loading="lazy"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        referrerPolicy="strict-origin-when-cross-origin"
        className="h-full w-full border-0"
      />
    </div>
  );
}

export function MediaEmbed({ url, kind }: { url: string; kind: MediaKind }) {
  const [failed, setFailed] = useState(false);
  // Our own uploads may fetch a first frame — see `isSelfHostedMedia`. A
  // stranger's file still gets `preload="none"`.
  const preload = isSelfHostedMedia(url) ? "metadata" : "none";

  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        className="mt-2 inline-block text-[12px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 break-all"
      >
        {url}
      </a>
    );
  }

  if (kind === "image") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        className="mt-2 block overflow-hidden rounded-lg border border-zinc-800"
      >
        {/* biome-ignore lint/performance/noImgElement: next/image would need
            remotePatterns '**' for arbitrary hosts, turning the optimizer into an
            open proxy anyone can aim at any URL on our bandwidth. Same trade as
            LinkPreviewCard. */}
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="max-h-[420px] w-auto max-w-full object-contain bg-zinc-950"
        />
      </a>
    );
  }

  if (kind === "video") {
    return (
      // Captions cannot exist for an arbitrary third-party file the poster only linked to.
      // biome-ignore lint/a11y/useMediaCaption: see above
      <video
        src={url}
        controls
        preload={preload}
        playsInline
        onError={() => setFailed(true)}
        className="mt-2 max-h-[420px] w-full rounded-lg border border-zinc-800 bg-black"
      />
    );
  }

  return (
    // biome-ignore lint/a11y/useMediaCaption: same as video above.
    <audio
      src={url}
      controls
      preload={preload}
      onError={() => setFailed(true)}
      className="mt-2 w-full"
    />
  );
}
