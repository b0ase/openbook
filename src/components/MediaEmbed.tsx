"use client";

import { useState } from "react";
import { downloadUrl, isSelfHostedMedia, type MediaKind } from "@/lib/media";
import { youTubeEmbedUrl } from "@/lib/youtube";

/**
 * Inline player for a post that links directly at an image, video, audio file
 * or PDF.
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

/**
 * "Save this" for media the board hosts.
 *
 * Renders NOTHING for a stranger's file, deliberately: `download` is ignored
 * cross-origin, so the button would silently open a tab instead of saving. An
 * affordance that does something other than what it says is worse than its
 * absence. `downloadUrl` is the single place that decision is made.
 */
function DownloadLink({ url, label = "Download" }: { url: string; label?: string }) {
  const href = downloadUrl(url);
  if (!href) return null;
  return (
    <a
      href={href}
      // No `target="_blank"`: the response carries an attachment disposition, so
      // a new tab would open and immediately close itself on every save.
      rel="nofollow ugc"
      className="text-[12px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
    >
      {label}
    </a>
  );
}

/**
 * A PDF in a post.
 *
 * ⚠ THE BROWSER'S OWN VIEWER, NOT A BUNDLED ONE. Rendering a first page with
 * pdf.js would mean shipping a megabyte of JavaScript into a project that runs
 * on eight dependencies, to reproduce something every browser already has. The
 * cost is that the preview is a frame rather than an image — which is why it is
 * only ever mounted for files we host.
 *
 * ⚠ A STRANGER'S PDF IS NEVER FRAMED. Same reasoning as `preload="none"`: a feed
 * of a hundred posts must not fetch a hundred whole documents from other
 * people's servers on scroll. Ours is our own bandwidth and our own bytes, so it
 * previews; anyone else's gets a card and a link.
 *
 * The frame is sandboxed WITHOUT `allow-same-origin`, so the document runs in an
 * opaque origin even though it is served from our host. `/m/[name]` additionally
 * sends `Content-Security-Policy: sandbox` — the frame attribute and the
 * response header are two independent controls on the same hole, because a PDF
 * can carry JavaScript and this one is served same-origin.
 */
function PdfEmbed({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const selfHosted = isSelfHostedMedia(url);

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 px-3 py-2">
        <span aria-hidden className="text-[14px] leading-none">
          📄
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-400">PDF document</span>
        {selfHosted && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[12px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
          >
            {open ? "Hide" : "Preview"}
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="text-[12px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
        >
          Open
        </a>
        <DownloadLink url={url} />
      </div>

      {selfHosted && open && (
        <iframe
          src={url}
          title="PDF preview"
          loading="lazy"
          sandbox="allow-scripts"
          className="h-[460px] w-full border-0 border-t border-zinc-800 bg-zinc-900"
        />
      )}
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

  if (kind === "pdf") {
    return <PdfEmbed url={url} />;
  }

  if (kind === "image") {
    return (
      <div className="mt-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="block overflow-hidden rounded-lg border border-zinc-800"
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
        <div className="mt-1 flex justify-end">
          <DownloadLink url={url} label="Save image" />
        </div>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="mt-2">
        {/* Captions cannot exist for an arbitrary third-party file the poster only linked to. */}
        {/* biome-ignore lint/a11y/useMediaCaption: see above */}
        <video
          src={url}
          controls
          preload={preload}
          playsInline
          onError={() => setFailed(true)}
          className="max-h-[420px] w-full rounded-lg border border-zinc-800 bg-black"
        />
        <div className="mt-1 flex justify-end">
          <DownloadLink url={url} label="Save video" />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      {/* biome-ignore lint/a11y/useMediaCaption: same as video above. */}
      <audio
        src={url}
        controls
        preload={preload}
        onError={() => setFailed(true)}
        className="w-full"
      />
      <div className="mt-1 flex justify-end">
        <DownloadLink url={url} label="Save audio" />
      </div>
    </div>
  );
}
