"use client";

import { useState } from "react";
import type { MediaKind } from "@/lib/media";

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
export function MediaEmbed({ url, kind }: { url: string; kind: MediaKind }) {
  const [failed, setFailed] = useState(false);

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
        preload="none"
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
      preload="none"
      onError={() => setFailed(true)}
      className="mt-2 w-full"
    />
  );
}
