"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { BootIcon } from "@/components/icons/BootIcon";
import { useBootContext } from "@/contexts/BootContext";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useBoot } from "@/hooks/useBoot";
import { FORK_POINT_ID, isInheritedPost } from "@/lib/fork-point";
import { titleCaseTicker } from "@/lib/ticker";
import type { Post } from "@/types";
import { Manifesto } from "./Manifesto";
import { PostContent } from "./PostContent";

// ── Inline amber spinner (16px, Tailwind animate-spin) ───────────────────────

function BootSpinner() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="animate-spin text-amber-400"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Status label map ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending: "",
  sending: "Sending...",
  retrying: "Retrying...",
  preparing: "Preparing...",
};

// ── Boot button ──────────────────────────────────────────────────────────────

interface BootButtonProps {
  postId: number;
  bootCount: number;
  postPubkey: string | null;
  bootPrice: number;
  freeBootsRemaining: number;
  onBooted?: () => void;
  onFundNeeded?: (address: string, balance?: number, fee?: number) => void;
  onFreeBootUsed?: () => void;
}

export function BootButton({
  postId,
  bootCount,
  postPubkey,
  bootPrice,
  freeBootsRemaining,
  onBooted,
  onFundNeeded,
  onFreeBootUsed,
}: BootButtonProps) {
  const { identity, requireIdentity } = useIdentityContext();
  const { bootingPostId, bootStatus, throttled, consolidationWarningDismissed } = useBootContext();
  const { boot } = useBoot({ onBooted, onFundNeeded, onFreeBootUsed });
  const [optimisticBoots, setOptimisticBoots] = useState(0);
  const prevBootCountRef = useRef(bootCount);

  useEffect(() => {
    setOptimisticBoots(0);
  }, []);

  // When the authoritative bootCount advances (the live-count poll caught up —
  // it already includes our own boot), clear the optimistic offset so we don't
  // double-count (would briefly show authoritative + 1). Live counts from other
  // sources also land here. See "Option B — live authoritative counts".
  useEffect(() => {
    if (bootCount > prevBootCountRef.current) setOptimisticBoots(0);
    prevBootCountRef.current = bootCount;
  }, [bootCount]);

  const isFree = freeBootsRemaining > 0;
  const canBoot = !!postPubkey;

  // Is this specific button currently booting?
  const isThisBooting = bootingPostId === postId;
  // Is any boot in progress (including this one)?
  const anyBooting = bootingPostId !== null;
  // Should this button be dimmed (another post is booting OR throttled)?
  const isDimmed = (anyBooting && !isThisBooting) || throttled;

  const showExtended =
    isThisBooting &&
    (bootStatus === "sending" || bootStatus === "retrying" || bootStatus === "preparing");

  const showConsolidationHint =
    isThisBooting && bootStatus === "preparing" && !consolidationWarningDismissed;

  async function handleBoot() {
    if (!postPubkey || anyBooting || throttled) return;
    // Opens SignInModal if locked; caller retaps after signing in.
    if (!requireIdentity() || !identity) return;
    setOptimisticBoots((prev) => prev + 1);
    const result = await boot(postId, identity);
    if (!result.success) {
      setOptimisticBoots((prev) => Math.max(0, prev - 1));
    }
  }

  const displayCount = bootCount + optimisticBoots;
  const title = !postPubkey
    ? "Unsigned post — cannot be boosted"
    : !identity
      ? "Sign in to boost"
      : isFree
        ? `Boost this post (FREE — ${freeBootsRemaining} remaining)`
        : `Boost this post (~${bootPrice.toLocaleString()} sats + network fee)`;

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={handleBoot}
        disabled={anyBooting || throttled || !canBoot}
        className={`relative -m-2 p-2 flex items-center gap-1 rounded-full transition-all border disabled:cursor-not-allowed ${
          isDimmed
            ? "opacity-50 text-zinc-600 border-zinc-800"
            : isThisBooting
              ? "text-amber-400 border-amber-500/40 bg-amber-500/5"
              : displayCount > 0
                ? "text-amber-500 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/10"
                : "text-zinc-600 border-zinc-800 hover:border-zinc-700 hover:text-amber-400 hover:bg-zinc-800/50"
        } ${!canBoot && !anyBooting ? "disabled:opacity-30" : ""}`}
        title={title}
      >
        {isThisBooting ? (
          <>
            <BootSpinner />
            {showExtended && (
              <span className="text-[9px] text-amber-400 pr-0.5">
                {STATUS_LABEL[bootStatus] ?? ""}
              </span>
            )}
          </>
        ) : (
          <BootIcon size={13} className={displayCount > 0 ? "text-amber-500" : ""} />
        )}
      </button>

      {/* Boost count — hide while actively booting this post */}
      {!isThisBooting && displayCount > 0 && (
        <span className="text-[9px] text-zinc-600 mt-0.5">{displayCount}</span>
      )}

      {/* Free label */}
      {!isThisBooting && isFree && canBoot && (
        <span className="text-[8px] text-emerald-600 mt-0.5">FREE</span>
      )}

      {/* First-time consolidation hint */}
      {showConsolidationHint && (
        <span className="text-[8px] text-amber-600 mt-1 text-center leading-tight max-w-[80px]">
          Setting up wallet... ~30s
        </span>
      )}
    </div>
  );
}

// ── Reply button ─────────────────────────────────────────────────────────────

/**
 * Anything inside a post that already does something when you click it.
 *
 * ⚠ THIS LIST IS WHAT MAKES A CLICKABLE ROW SAFE. Tapping a post opens its
 * thread, but a post is full of controls that mean something else — a `$Ticker`
 * link, an image, video and audio controls, a PDF's Preview/Open/Download, the
 * unfurl card, the boost button, "View on chain". Without this check every one
 * of them would ALSO open the thread, so following a link would yank the reader
 * into an overlay they did not ask for.
 */
const INTERACTIVE = "a, button, video, audio, iframe, input, textarea, select, label, summary";

/**
 * Whether a click on a post row should open its thread.
 *
 * Three things have to be true, and each one is a bug people actually hit in
 * feeds that get this wrong:
 *
 *  - it is a plain left click. Cmd/ctrl/shift-click and middle click belong to
 *    the browser (open in a new tab), and hijacking them is infuriating.
 *  - the click did not land on a control. See `INTERACTIVE`.
 *  - the reader is not selecting text. Dragging across a post to copy it ends in
 *    a click event, and opening an overlay at that moment throws away both the
 *    selection and their place in the feed.
 */
function openThreadFromRowClick(
  e: React.MouseEvent<HTMLElement>,
  post: Post,
  onOpenThread?: (rootId: number) => void
) {
  if (!onOpenThread) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
  if ((window.getSelection()?.toString().length ?? 0) > 0) return;
  onOpenThread(post.root_id ?? post.id);
}

/**
 * Opens the thread for a post. Reading a thread needs no identity — the
 * sign-in gate lives on the reply composer inside the thread view, so tapping
 * through to read never prompts anyone to sign in (same rule as the AI chat and
 * scrolling; see the "transaction action requires sign-in" section in CLAUDE.md).
 */
function ReplyButton({
  replyCount,
  onOpenThread,
}: {
  replyCount: number;
  onOpenThread: () => void;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={onOpenThread}
        className={`relative -m-2 p-2 flex items-center gap-1 rounded-full transition-all border ${
          replyCount > 0
            ? "text-zinc-400 border-zinc-700 hover:border-zinc-600 hover:text-zinc-200 hover:bg-zinc-800/50"
            : "text-zinc-600 border-zinc-800 hover:border-zinc-700 hover:text-zinc-300 hover:bg-zinc-800/50"
        }`}
        title={
          replyCount === 0
            ? "Open thread"
            : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
        }
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
        </svg>
      </button>
      {replyCount > 0 && <span className="text-[9px] text-zinc-600 mt-0.5">{replyCount}</span>}
    </div>
  );
}

// ── PostList ─────────────────────────────────────────────────────────────────

/**
 * Whether the fork marker belongs immediately above this row.
 *
 * True for the first OpenBooks-era post in the window, and only when the row
 * before it is on the other side — so it appears exactly once, and only when the
 * loaded window actually spans the boundary.
 */
function isForkBoundary(posts: Post[], post: Post, i: number): boolean {
  return post.id > FORK_POINT_ID && (i === 0 || posts[i - 1].id <= FORK_POINT_ID);
}

/**
 * The fork boundary: everything above came from OpenCook, everything below is
 * OpenBooks's own.
 *
 * ⚠ ALSO RENDERED WHEN THE FEED IS EMPTY. It normally attaches above the first
 * OpenBooks-era post — but a board with no posts of its own yet has no such row,
 * and then the toggle would be the only route to the inherited history AND
 * absent. That is exactly the state a fresh deploy is in. See the empty-state
 * branch in PostList.
 */
function ForkMarker({
  showInherited,
  onToggleInherited,
}: {
  showInherited?: boolean;
  onToggleInherited?: () => void;
}) {
  return (
    <div className="my-6 rounded-lg border border-amber-500/40 bg-gradient-to-b from-amber-500/10 to-transparent px-4 py-5 text-center">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-px bg-amber-500/40" />
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
          The Fork
        </span>
        <div className="flex-1 h-px bg-amber-500/40" />
      </div>
      <p className="text-lg sm:text-xl font-bold tracking-tight text-white leading-tight">
        <span className="text-amber-400">$Open</span>Books starts here
      </p>
      {/* The copy has to follow the toggle. "Everything above is inherited" is
          simply false while the run-up is hidden — and it is hidden by default,
          so the wrong version was the one almost everyone would have seen. */}
      <p className="mt-2 text-[13px] text-zinc-400 leading-relaxed max-w-md mx-auto">
        {showInherited ? (
          <>
            Everything above is inherited from <span className="text-zinc-300">OpenCook</span> — the
            same posts, the same authors, the same signatures on-chain. Everything below is ours.
          </>
        ) : (
          <>
            This board starts here. What came before was written on{" "}
            <span className="text-zinc-300">OpenCook</span> by other people — still on-chain, still
            readable, but not shown as though it were said here.
          </>
        )}
      </p>
      <p className="mt-2 text-[11px] text-zinc-500">
        We forked over one thing: being paid for a contribution isn't the same as owning a piece of
        it.
      </p>
      {/* ⚠ THE RUN-UP IS HIDDEN BY DEFAULT, AND THIS IS THE ONLY WAY IN.
                  Those posts were written on OpenCook by other people. Rendering
                  them inline, unlabelled, presents them as things said HERE —
                  which is not true, and not ours to imply. They stay in the
                  database and stay reachable, because a fork you cannot check is
                  just a claim; they simply do not masquerade as this board's
                  own history. */}
      {onToggleInherited && (
        <button
          type="button"
          onClick={onToggleInherited}
          className="mt-3 text-[11px] text-zinc-400 hover:text-amber-400 underline underline-offset-2 decoration-zinc-600 hover:decoration-amber-400/60 transition-colors"
        >
          {showInherited ? "Hide the run-up" : "Show the run-up on OpenCook that led here"}
        </button>
      )}
    </div>
  );
}

interface PostListProps {
  posts: Post[];
  mode: "live" | "origin";
  /** LIVE mode only: render an unread divider immediately before this post. */
  firstUnreadId?: number;
  genesisRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  observerRef: React.RefObject<IntersectionObserver | null>;
  /** ORIGIN mode only: bottom sentinel that auto-loads newer posts (read forward). */
  fwdSentinelRef: React.RefObject<HTMLDivElement | null>;
  originHasMore: boolean;
  isLoadingForward: boolean;
  /** LIVE mode only: top sentinel that auto-loads older posts (scroll up). */
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** LIVE mode: older history still remains (post #1 not yet loaded). */
  liveHasMore: boolean;
  isLoadingOlder: boolean;
  /** Oldest id of the newest (polled) window — only these are observed for unread. */
  oldestServerId: number;
  onBooted?: () => void;
  onAskAgent?: () => void;
  onFundNeeded?: (address: string, balance?: number, fee?: number) => void;
  onFreeBootUsed?: () => void;
  bootPrice: number;
  freeBootsRemaining: number;
  /** Open the thread rooted at this post (THREADS.md step 4). */
  onOpenThread?: (rootId: number) => void;
  /** Open the thread a `$Ticker` in post text names. */
  onOpenTicker?: (symbol: string) => void;
  /** True when the inherited OpenCook run-up is being shown above the fork. */
  showInherited?: boolean;
  /** Toggle the inherited run-up in and out of the feed. */
  onToggleInherited?: () => void;
  /** Tokens issued per ticker — see PostText. */
  tickerSupply?: Record<string, number>;
  /** Original filenames for uploads, keyed by stored name — see PostContent. */
  attachmentNames?: Record<string, string>;
}

export function PostList({
  posts,
  mode,
  firstUnreadId,
  genesisRef,
  bottomRef,
  observerRef,
  fwdSentinelRef,
  originHasMore,
  isLoadingForward,
  topSentinelRef,
  liveHasMore,
  isLoadingOlder,
  oldestServerId,
  onBooted,
  onAskAgent,
  onFundNeeded,
  onFreeBootUsed,
  bootPrice,
  freeBootsRemaining,
  onOpenThread,
  onOpenTicker,
  showInherited,
  onToggleInherited,
  tickerSupply,
  attachmentNames,
}: PostListProps) {
  // Re-render every 60s to keep timeAgo labels fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 pt-3">
      {/* TOP CAP — the vision/manifesto appears only when there's nothing older to
          load (ORIGIN always; LIVE once post #1 is reached). Mutually exclusive
          with the upward-load sentinel, so a prepend can never yank it. The real
          founding conversation now lives in the feed itself (seeded posts), so the
          old hardcoded genesis sample was removed. */}
      {(mode === "origin" || (mode === "live" && !liveHasMore)) && (
        <>
          <div ref={genesisRef} />
          <Manifesto onAskAgent={onAskAgent} />
        </>
      )}

      {/* LIVE upward-load sentinel — only while older history remains. */}
      {mode === "live" && liveHasMore && (
        <>
          <div ref={topSentinelRef} aria-hidden className="h-px" />
          {isLoadingOlder && (
            <div className="flex justify-center py-4">
              <span className="text-xs text-zinc-500">Loading…</span>
            </div>
          )}
        </>
      )}

      {posts.length === 0 && (
        <>
          <p className="py-16 text-center text-sm text-zinc-600">
            No posts yet. Be the first to share an idea.
          </p>
          {/* No OpenBooks post exists yet, so no row can carry the boundary — and
              without this the inherited history would be unreachable on a board
              that has not been posted to. */}
          <ForkMarker showInherited={showInherited} onToggleInherited={onToggleInherited} />
        </>
      )}

      <div className="divide-y divide-zinc-800/60">
        {posts.map((post, i) => (
          <Fragment key={post.id}>
            {/* Fork boundary — everything above came from OpenCook, everything
                below is OpenBooks's own. Rendered before the first post past the
                fork point, and only when the previous row is on the other side,
                so it appears exactly once and only when the window spans it. */}
            {isForkBoundary(posts, post, i) && (
              <ForkMarker showInherited={showInherited} onToggleInherited={onToggleInherited} />
            )}
            {mode === "live" && firstUnreadId != null && post.id === firstUnreadId && (
              <div className="flex items-center gap-3 py-2">
                <div className="flex-1 h-px bg-amber-500/50" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-amber-400">
                  New
                </span>
                <div className="flex-1 h-px bg-amber-500/50" />
              </div>
            )}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row click is a
                POINTER CONVENIENCE, not the accessible path. `ReplyButton` in the
                gutter is a real focusable button that opens the same thread, so
                nothing here is keyboard- or screen-reader-inaccessible. Giving the
                article a role and a key handler would instead nest the post's own
                links, buttons and media controls inside an interactive element,
                which is worse for assistive tech than leaving it presentational. */}
            <article
              data-post-id={post.id}
              ref={(el) => {
                // Observe ONLY the newest window — unread tracking never concerns
                // prepended history, so the observed set stays bounded at depth.
                if (el && observerRef.current && mode === "live" && post.id >= oldestServerId) {
                  observerRef.current.observe(el);
                }
              }}
              onClick={(e) => openThreadFromRowClick(e, post, onOpenThread)}
              className={`py-3.5 group ${onOpenThread ? "cursor-pointer" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <PostContent
                    post={post}
                    onOpenTicker={onOpenTicker}
                    tickerSupply={tickerSupply}
                    attachmentNames={attachmentNames}
                    badge={
                      /* ⚠ AN INHERITED POST IS LABELLED BEFORE ANYTHING ELSE. These
                         rows are other people's words, written on another board.
                         Whatever else a row might be, saying WHERE it came from
                         outranks it — an unlabelled OpenCook post in this feed is
                         the misrepresentation the toggle exists to prevent. */
                      isInheritedPost(post.id) ? (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 border border-zinc-700 rounded px-1 py-px shrink-0"
                          title="Written on OpenCook, before the fork — reproduced here, not written here"
                        >
                          OpenCook
                        </span>
                      ) : /* The first post of OpenBooks's own timeline, once nothing
                             newer-side remains above it. */
                      i === 0 && (mode === "origin" || (mode === "live" && !liveHasMore)) ? (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wider text-amber-400/80 border border-amber-500/30 rounded px-1 py-px shrink-0"
                          title="The first post — where OpenBooks began"
                        >
                          Genesis
                        </span>
                      ) : undefined
                    }
                  />
                </div>
                <div className="shrink-0 self-center flex flex-col items-center gap-3">
                  <BootButton
                    postId={post.id}
                    bootCount={post.boot_count}
                    postPubkey={post.pubkey}
                    bootPrice={bootPrice}
                    freeBootsRemaining={freeBootsRemaining}
                    onBooted={onBooted}
                    onFundNeeded={onFundNeeded}
                    onFreeBootUsed={onFreeBootUsed}
                  />
                  <ReplyButton
                    replyCount={post.reply_count ?? 0}
                    onOpenThread={() => onOpenThread?.(post.id)}
                  />
                </div>
              </div>
              {/* ⚠ THE REPLY, ON THE SCREEN THE READER IS ALREADY LOOKING AT.
                  A reply lived behind a ~20px icon in the right gutter, visually
                  identical to the boost control above it — so an agent answering
                  a direct question was invisible, and the whole feature read as
                  broken for hours while it was in fact working. Showing the
                  newest reply inline is the difference between a board that
                  answers you and one that appears not to. */}
              {post.latest_reply_content && (
                <button
                  type="button"
                  onClick={() => onOpenThread?.(post.id)}
                  className="mt-2 ml-3 flex w-[calc(100%-0.75rem)] gap-2 border-l-2 border-zinc-800 pl-3 text-left transition-colors hover:border-amber-400/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-[11px] font-medium text-zinc-400">
                      {post.latest_reply_nym
                        ? `$${titleCaseTicker(post.latest_reply_nym)}`
                        : post.latest_reply_author}
                    </span>{" "}
                    <span className="text-[13px] leading-relaxed text-zinc-300 break-words">
                      {post.latest_reply_content.length > 180
                        ? `${post.latest_reply_content.slice(0, 179).trimEnd()}\u2026`
                        : post.latest_reply_content}
                    </span>
                    {(post.reply_count ?? 0) > 1 && (
                      <span className="ml-1 text-[11px] text-zinc-600">
                        · {post.reply_count} replies
                      </span>
                    )}
                  </span>
                </button>
              )}
            </article>
          </Fragment>
        ))}
      </div>

      {/* ORIGIN mode: reading forward. This bottom sentinel auto-loads newer posts
          as you scroll down (append — smooth, no scroll-anchor math). */}
      {mode === "origin" && originHasMore && (
        <>
          <div ref={fwdSentinelRef} aria-hidden className="h-px" />
          {isLoadingForward && (
            <div className="flex justify-center py-4">
              <span className="text-xs text-zinc-500">Loading…</span>
            </div>
          )}
        </>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
