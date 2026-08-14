"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { formatShare } from "@/lib/share";
import { ROOT_TICKER, titleCaseTicker } from "@/lib/ticker";
import { timeAgo } from "@/lib/utils";
import type { Post } from "@/types";
import { getThread, getThreadShare, getThreadTicker, getTickerPath } from "./actions";
import { IdentityChip } from "./IdentityBar";
import { PostContent } from "./PostContent";
import { PostForm } from "./PostForm";
import { BootButton } from "./PostList";

/**
 * Thread view (THREADS.md step 4).
 *
 * ⚠ AN OVERLAY, NOT A THIRD FEED MODE. The feed's LIVE/ORIGIN machinery —
 * bottom-relative prepend anchoring, the landing effect, the two sentinels, the
 * unread watermark — is a set of individually hard-won invariants, and each one
 * assumes the scroll container holds the root feed. A third mode would have put
 * all of them in play for a feature that needs none of them. This mounts over
 * the feed with its OWN scroll container instead, so opening a thread cannot
 * disturb the feed's scroll position, and closing it restores nothing because
 * nothing was moved. THREADS.md's "root-feed unchanged" is literal here.
 *
 * Replies target the ROOT, not the tapped post. The schema stores arbitrary
 * depth and the thread query handles it, but a flat render (the settled
 * decision) with a per-reply reply button would silently produce nesting the UI
 * cannot show. Depth stays available for a future "replying to" chip.
 */

const POLL_MS = 5000;

interface OptimisticReply {
  id: number;
  content: string;
  author_name: string;
  created_at: string;
  failed?: boolean;
  failReason?: string;
}

interface ThreadViewProps {
  rootId: number;
  bootPrice: number;
  freeBootsRemaining: number;
  onClose: () => void;
  /** Bubble a boot up so the feed's counts and the bootboard refresh too. */
  onBooted?: () => void;
  onFundNeeded?: (address: string, balance?: number, fee?: number) => void;
  onFreeBootUsed?: () => void;
  /** Open the thread a `$Ticker` names — navigates between threads in place. */
  onOpenTicker?: (symbol: string) => void;
}

export function ThreadView({
  rootId,
  bootPrice,
  freeBootsRemaining,
  onClose,
  onBooted,
  onFundNeeded,
  onFreeBootUsed,
  onOpenTicker,
}: ThreadViewProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [ticker, setTicker] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState<OptimisticReply[]>([]);
  const [share, setShare] = useState<{ mine: number; total: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { identity } = useIdentityContext();

  const refresh = useCallback(async () => {
    const thread = await getThread(rootId);
    setPosts(thread);
    setLoading(false);
  }, [rootId]);

  // Your stake in the thread you are reading. Recomputed alongside the poll (not
  // on its own timer) so the share can never describe a different revision of
  // the thread than the posts underneath it.
  const pubkey = identity?.pubkey;
  const refreshShare = useCallback(async () => {
    if (!pubkey) {
      setShare(null);
      return;
    }
    setShare(await getThreadShare(rootId, pubkey));
  }, [rootId, pubkey]);

  useEffect(() => {
    void refreshShare();
  }, [refreshShare]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The ticker is immutable once claimed (first claim wins), so it is fetched
  // once per thread rather than on the poll.
  useEffect(() => {
    let live = true;
    void getThreadTicker(rootId).then(async (t) => {
      if (!live) return;
      setTicker(t);
      // The ancestry, so the header reads $OpenBook/$Test rather than a bare name
      // — a token's position in the tree is part of what it IS.
      setPath(t ? await getTickerPath(t) : []);
    });
    return () => {
      live = false;
    };
  }, [rootId]);

  // Keep the thread live the same way the feed is, and for the same reason: a
  // reply from someone else should appear without a manual refresh. Skipped
  // while the tab is hidden so a backgrounded thread costs nothing.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) {
        void refresh();
        // Someone else replying dilutes your share, so it has to move on the same
        // tick as the posts — a stale percentage beside fresh replies is worse
        // than no percentage.
        void refreshShare();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, refreshShare]);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drop an optimistic reply once the real row arrives (same content + author).
  const pending = optimistic.filter(
    (op) => !posts.some((p) => p.content === op.content && p.author_name === op.author_name)
  );

  const handleReplyCreated = useCallback(
    (content: string, author: string, tempId: number) => {
      setOptimistic((prev) => [
        ...prev,
        { id: tempId, content, author_name: author, created_at: new Date().toISOString() },
      ]);
      setTimeout(() => {
        void refresh();
      }, 500);
    },
    [refresh]
  );

  const handleReplyRejected = useCallback((tempId: number, reason?: string) => {
    setOptimistic((prev) =>
      prev.map((op) => (op.id === tempId ? { ...op, failed: true, failReason: reason } : op))
    );
    setTimeout(() => setOptimistic((prev) => prev.filter((op) => op.id !== tempId)), 3000);
  }, []);

  // A new reply lands at the bottom — follow it, the way the feed follows your
  // own post.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on list growth
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [posts.length, pending.length]);

  const handleBooted = useCallback(() => {
    void refresh();
    onBooted?.();
  }, [refresh, onBooted]);

  const replyCount = Math.max(0, posts.length - 1);

  return (
    <div className="fixed inset-0 z-40 flex flex-col h-[100dvh] bg-black">
      <header className="shrink-0 border-b border-zinc-800 bg-black">
        {/* `justify-between` with the crumb group and the chip as the two ends:
            the overlay covers the whole viewport including the app header, so
            without the chip here the wallet simply disappears on every shared
            ticker link — the exact URLs most likely to be someone's first
            landing. `min-w-0` on the crumb group so a deep path truncates
            instead of pushing the chip off-screen. */}
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to feed"
              className="relative -m-2 p-2 shrink-0 text-zinc-400 hover:text-amber-400 transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M19 12H5m0 0l7 7m-7-7l7-7" />
              </svg>
            </button>
            <div className="min-w-0">
              {/* Headline the thread by the name it was claimed under. A thread
                that carries a ticker IS that idea, so the symbol is the title
                and "Thread" is only the fallback for unnamed ones. */}
              <h1 className="text-base font-semibold tracking-tight leading-none">
                {path.length ? (
                  path.map((seg, i) => {
                    const isLeaf = i === path.length - 1;
                    return (
                      <span key={seg}>
                        {i > 0 && <span className="text-zinc-600 mx-0.5">/</span>}
                        {/* The leaf is this thread — a link to where you already are
                          is a dead control, so only ancestors are clickable. They
                          are dimmed because they are context, not the subject. */}
                        {isLeaf ? (
                          <span className="text-amber-400">${titleCaseTicker(seg)}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              // The main feed IS the root token's thread, so the root
                              // crumb closes the overlay rather than opening a thread
                              // that would duplicate the feed behind it.
                              if (seg === ROOT_TICKER) onClose();
                              else onOpenTicker?.(seg);
                            }}
                            className="text-zinc-500 hover:text-amber-300 transition-colors"
                            title={`Go to $${titleCaseTicker(seg)}`}
                          >
                            ${titleCaseTicker(seg)}
                          </button>
                        )}
                      </span>
                    );
                  })
                ) : ticker ? (
                  <span className="text-amber-400">${titleCaseTicker(ticker)}</span>
                ) : (
                  <span className="text-zinc-100">Thread</span>
                )}
              </h1>
              <p className="text-[11px] text-zinc-500 tracking-wide mt-0.5">
                {loading
                  ? "Loading…"
                  : replyCount === 0
                    ? "No replies yet"
                    : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
                {/* Your stake in the thread you are looking at. Shown only when you
                  actually hold some: "0%" on every thread you have never posted
                  in would be noise on most of them, and would read as a loss
                  rather than an absence. */}
                {share && share.mine > 0 && (
                  <>
                    <span className="text-zinc-700 mx-1.5">·</span>
                    <span
                      className="text-amber-400/90 font-mono tabular-nums"
                      title={`You wrote ${share.mine} of ${share.total} posts in this thread`}
                    >
                      {formatShare(share.mine, share.total)}
                    </span>
                    <span className="text-zinc-600"> yours</span>
                  </>
                )}
              </p>
            </div>
          </div>
          {/* Same chip as the app header — the same component, so the locked /
              unlocked / read-only states cannot diverge between the feed and a
              thread. */}
          <div className="shrink-0">
            <IdentityChip />
          </div>
        </div>
      </header>

      <div
        className="flex-1 overflow-y-auto overscroll-y-contain scrollbar-hide"
        style={{ scrollbarWidth: "none" }}
      >
        <div className="mx-auto max-w-2xl px-4 pt-3">
          {!loading && posts.length === 0 && (
            <p className="py-16 text-center text-sm text-zinc-600">
              This thread is no longer available.
            </p>
          )}

          <div className="divide-y divide-zinc-800/60">
            {posts.map((post) => {
              const isRoot = post.parent_id === null;
              return (
                <article key={post.id} className={`py-3.5 ${isRoot ? "" : "pl-4"}`}>
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex-1 min-w-0 ${isRoot ? "" : "border-l border-zinc-800 pl-3"}`}
                    >
                      <PostContent post={post} onOpenTicker={onOpenTicker} />
                    </div>
                    <div className="shrink-0 self-center">
                      <BootButton
                        postId={post.id}
                        bootCount={post.boot_count}
                        postPubkey={post.pubkey}
                        bootPrice={bootPrice}
                        freeBootsRemaining={freeBootsRemaining}
                        onBooted={handleBooted}
                        onFundNeeded={onFundNeeded}
                        onFreeBootUsed={onFreeBootUsed}
                      />
                    </div>
                  </div>
                </article>
              );
            })}

            {pending.map((op) => (
              <article key={op.id} className={`py-3.5 pl-4 ${op.failed ? "opacity-50" : ""}`}>
                <div className="border-l border-zinc-800 pl-3">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-300">{op.author_name}</span>
                    <span>·</span>
                    <time>{timeAgo(op.created_at)}</time>
                    {op.failed && (
                      <span className="text-red-400 text-[10px]">
                        {op.failReason === "rate_limited"
                          ? "Too fast — try again"
                          : op.failReason === "daily_limit"
                            ? "Daily post limit reached"
                            : op.failReason === "paused"
                              ? "Posting briefly paused"
                              : op.failReason === "rejected_content"
                                ? "Can't be posted"
                                : op.failReason === "invalid_parent"
                                  ? "This thread is no longer available"
                                  : "Failed to post"}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-zinc-200 whitespace-pre-wrap break-words">
                    {op.content}
                  </p>
                </div>
              </article>
            ))}
          </div>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Same keyboard-collapse `group` treatment as the feed's compose area. */}
      <div className="shrink-0">
        <div className="group mx-auto max-w-2xl px-4 pb-4 pt-2 transition-all duration-200 pointer-coarse:has-[textarea:focus,.compose-send:focus]:pb-2">
          <PostForm
            parentId={rootId}
            compact
            placeholder="Reply…"
            onPostCreated={handleReplyCreated}
            onPostRejected={handleReplyRejected}
          />
        </div>
      </div>
    </div>
  );
}
