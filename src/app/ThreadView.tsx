"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { RoomGate, RoomPosition } from "@/components/RoomGate";
import { SellModal } from "@/components/SellModal";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { readCachedNym } from "@/lib/nym-cache";
import type { RoomAccess } from "@/lib/room-access";
import { formatShare } from "@/lib/share";
import { distinctTickers, isRootTicker, titleCaseTicker } from "@/lib/ticker";
import { timeAgo } from "@/lib/utils";
import { getStoredAddress } from "@/services/bsv/identity";
import type { Post } from "@/types";
import {
  enterRoomAction,
  getRoomAccess,
  getRoomPosition,
  getThread,
  getThreadShare,
  getThreadTicker,
  getTickerMeaningFor,
  getTickerPath,
  getTickerSupply,
  type RoomPosition as RoomPositionData,
} from "./actions";
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
 * ⚠ A ROOM IS A CONVERSATION, NOT A SEARCH RESULT (owner, 2026-08-17). This
 * view used to append EVERY post the name had ever written — `getPostsByNym` —
 * under a "Posts by $X" heading. It was added for a real reason (an agent that
 * only ever replies inside other people's threads showed "No replies yet" on
 * its own page and looked mute), but it was the wrong fix: it pulled unrelated
 * messages from unrelated conversations into one page, which is what the owner
 * called *"clustering all the mentions together… threads of incoherent
 * bullshit"*.
 *
 * ⚠ IT WAS ALSO A HOLE IN THE DOOR. That block rendered OUTSIDE the room gate,
 * so a non-holder opening a name's room saw everything that name had ever
 * written. Both problems had one cause and one fix. "Everything $X said" is a
 * PROFILE, a different surface, and not what a ticket buys.
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
  /** See Feed's OptimisticPost — the same anon_xxxx flash applies to replies. */
  author_nym?: string | null;
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
  /** Open a thread by id — the wallet's holdings rows, which know root ids
   *  rather than symbols. Swaps this overlay for that thread in place. */
  onOpenThread?: (rootId: number) => void;
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
  onOpenThread,
}: ThreadViewProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [ticker, setTicker] = useState<string | null>(null);
  /** What this word has come to mean, written by its agent from actual usage. */
  const [meaning, setMeaning] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ text: string; url: string | null } | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState<OptimisticReply[]>([]);
  const [share, setShare] = useState<{ mine: number; total: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { identity, sign } = useIdentityContext();
  /**
   * Whether this reader holds a ticket to this room, and what one costs.
   *
   * `null` while unknown — and the room is NOT shown during that gap. Rendering
   * the conversation first and gating a beat later would show every non-holder
   * the thing they have not paid for, which is the only failure mode of a door
   * that actually matters.
   */
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  /** This holder's position — only fetched once the door is open. */
  const [position, setPosition] = useState<RoomPositionData | null>(null);
  const [selling, setSelling] = useState(false);

  const refresh = useCallback(async () => {
    // The viewer decides what comes back — a room sends its messages only to
    // somebody holding a ticket. See getThread.
    // ⚠ THE ADDRESS TOO. A protected identity is LOCKED by default, and a locked
    // wallet has no pubkey — so passing only that turned every locked holder
    // into a stranger at a room they own. See `getStoredAddress`.
    const thread = await getThread(rootId, identity?.pubkey ?? null, getStoredAddress());
    setPosts(thread);
    setLoading(false);
  }, [rootId, identity?.pubkey]);

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

  // Same figure as the feed shows beside a $Ticker, so a token's share does not
  // silently disappear when the reader opens the thread it names.
  const [tickerSupply, setTickerSupply] = useState<Record<string, number>>({});
  const visibleTickers = useMemo(() => {
    const all = new Set<string>();
    for (const p of posts) for (const t of distinctTickers(p.content)) all.add(t);
    return [...all].sort().join(",");
  }, [posts]);
  useEffect(() => {
    if (!visibleTickers) return;
    let live = true;
    void getTickerSupply(visibleTickers.split(",")).then((m) => {
      if (live) setTickerSupply(m);
    });
    return () => {
      live = false;
    };
  }, [visibleTickers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read on identity change as well as on thread change: burning a ticket, or
  // signing in as somebody who is already a member, has to open the door without
  // a reload.
  const refreshAccess = useCallback(async () => {
    const next = await getRoomAccess(rootId, identity?.pubkey ?? null, getStoredAddress());
    setAccess(next);
    // ⚠ `entered`, NOT `held`. A member burned their ticket to get in, so their
    // balance is zero — gating the card on units would hide it from precisely the
    // people it is for. Asking at the door would also be a query per stranger for
    // a card they never see.
    setPosition(
      next.symbol && next.entered
        ? await getRoomPosition(next.symbol, identity?.pubkey ?? null, getStoredAddress())
        : null
    );
  }, [rootId, identity?.pubkey]);

  useEffect(() => {
    void refreshAccess();
  }, [refreshAccess]);

  // The ticker is immutable once claimed (first claim wins), so it is fetched
  // once per thread rather than on the poll.
  useEffect(() => {
    let live = true;
    void getThreadTicker(rootId).then(async (t) => {
      if (!live) return;
      setTicker(t);
      // Only a claimed nym has an author to show; a topic ticker returns nothing
      // and this stays invisible.
      if (t) {
        void getTickerMeaningFor(t)
          .then((m) => {
            if (!live) return;
            setMeaning(m?.meaning ?? null);
            setAnchor(m?.anchor ? { text: m.anchor, url: m.anchorUrl ?? null } : null);
          })
          .catch(() => {
            if (live) {
              setMeaning(null);
              setAnchor(null);
            }
          });
      }
      // The ancestry, so the header reads $OpenBooks/$Test rather than a bare name
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
        {
          id: tempId,
          content,
          author_name: author,
          author_nym: readCachedNym(identity?.pubkey),
          created_at: new Date().toISOString(),
        },
      ]);
      setTimeout(() => {
        void refresh();
      }, 500);
    },
    [refresh, identity?.pubkey]
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

  /**
   * Locked out: this thread is a room and the reader has not burned a ticket.
   *
   * ⚠ MEMBERSHIP, NOT BALANCE. Entry destroys the unit, so `held === 0` is the
   * NORMAL state of a member — testing it locked out everybody who had actually
   * paid, and let in anybody merely holding stock they had not spent at the door.
   *
   * ⚠ `access === null` IS NOT LOCKED AND IS NOT OPEN — it is unknown, and the
   * render below treats it as "show nothing but the root yet". Guessing either
   * way for one frame either flashes a paid room at somebody who has not paid
   * or flashes a paywall at somebody who has.
   */
  const locked = access?.gated && !access.entered;
  const accessUnknown = access === null;

  /**
   * ⚠ A LOCKED ROOM SHOWS THE DOOR AND NOTHING ELSE (owner, 2026-08-17).
   *
   * This used to keep the root post visible, on the reasoning that it is public
   * anyway — it is in the feed, and it is what somebody tapped to get here. The
   * owner tested it from a browser with no ticket and the answer was simply
   * *"I can still see a post by $B0ase — and I shouldn't be able to."* He is
   * right about the surface even though the root really is public elsewhere: a
   * door with the room's first message printed under it does not read as a
   * door, it reads as a paywall somebody forgot to finish.
   */
  const visiblePosts = locked || accessUnknown ? [] : posts;

  const replyCount = Math.max(0, posts.length - 1);

  return (
    // ⚠ ABOVE THE TAB BAR (`z-50`), NOT BELOW IT. This was `z-40`, so once the
    // bar existed it painted OVER this overlay and swallowed the reply composer
    // at the bottom — worse in the installed PWA, where the safe-area inset makes
    // the bar taller and hid the composer completely. A thread is a full-screen
    // surface with its own header and close; the tab bar showing through the
    // bottom of it was never right, and covering its composer made replying
    // impossible with nothing on screen to explain why.
    <div className="fixed inset-0 z-[60] flex h-[100dvh] flex-col bg-black">
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
                              if (isRootTicker(seg)) onClose();
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
                {/* ⚠ SAY NOTHING RATHER THAN SOMETHING FALSE. A non-holder is
                    sent the root alone, so this counted to zero and printed
                    "Nothing said here yet" over a room that had a conversation
                    in it. The count is not a secret — but a WRONG count is worse
                    than no count, and it is the door's job to say the room is
                    shut, not to describe what is inside. */}
                {loading
                  ? "Loading…"
                  : locked || accessUnknown
                    ? "Members only"
                    : replyCount === 0
                      ? "Nothing said here yet"
                      : `${replyCount} ${replyCount === 1 ? "message" : "messages"}`}
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
            <IdentityChip onOpenThread={onOpenThread} />
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

          {/* Already in: your position, kept in view. See `RoomPosition`. */}
          {position && <RoomPosition position={position} onSell={() => setSelling(true)} />}

          {/* ⚠ THE DOOR COMES FIRST (owner, 2026-08-17). It sat under the root
            post, on the theory that a buyer should see what they are buying
            into — but a paywall below the fold reads as a footnote, and the
            reader has to scroll past the one post they CAN see to find out
            why there is nothing after it. The root post stays visible
            underneath: it is already public in the feed, and it is what they
            tapped to get here. A holder never sees this at all. */}
          {locked && access && (
            <RoomGate
              access={access}
              onClose={onClose}
              onBuy={async (text) => {
                if (!identity || buying) return;
                setBuying(true);
                setBuyError(null);
                const { executeBuy } = await import("@/services/bsv/buy-units");
                const res = await executeBuy({ identity, sign, text });
                setBuying(false);
                if (!res.ok) {
                  setBuyError(res.message);
                  return;
                }
                // The door opens by re-reading holdings, not by assuming — the
                // server decides who holds what.
                await refreshAccess();
                await refresh();
              }}
              onBuyListing={async (listingId) => {
                if (!identity || buying) return;
                setBuying(true);
                setBuyError(null);
                const { buyListing } = await import("@/services/bsv/buy-listing");
                const res = await buyListing({ identity, sign, listingId, units: 1 });
                setBuying(false);
                if (!res.ok) {
                  // ⚠ THE MESSAGE COMES FROM THE BUYER'S SIDE, unchanged. A
                  // market purchase pays BEFORE the transfer can be confirmed,
                  // so some of these failures happen with the money already
                  // gone — `buyListing` knows which, and rewording it here
                  // would be how somebody gets told their funds are safe when
                  // they are not.
                  setBuyError(res.message);
                  return;
                }
                await refreshAccess();
                await refresh();
              }}
              onEnter={async () => {
                if (!identity || buying) return;
                setBuying(true);
                setBuyError(null);
                /**
                 * ⚠ SIGNED, BECAUSE IT DESTROYS SOMETHING. Entry burns a unit, so
                 * the server will not act on a bare pubkey — it verifies a
                 * signature over `enter-room:<SYMBOL>`. The symbol is in the
                 * message so a captured signature cannot be replayed against a
                 * dearer door.
                 */
                const symbol = access.symbol ?? "";
                const { enterRoomMessage } = await import("@/lib/room-entry-message");
                const signed = await sign(enterRoomMessage(symbol));
                setBuying(false);
                if (!signed) {
                  setBuyError("Could not sign — try again.");
                  return;
                }
                const fd = new FormData();
                fd.set("symbol", symbol);
                // ⚠ THE PUBKEY FROM THE SIGNATURE, not from `identity`. The
                // server derives nothing here; it verifies the signature against
                // the key it is given, so the two must be the same pair.
                fd.set("pubkey", signed.pubkey);
                fd.set("signature", signed.signature);
                const res = await enterRoomAction(fd);
                if (!res.ok) {
                  setBuyError(
                    res.reason === "no_ticket"
                      ? "That ticket is no longer there — buy one and try again."
                      : "Could not open the door. Try again."
                  );
                  return;
                }
                // The door opens by re-reading membership, not by assuming.
                await refreshAccess();
                await refresh();
              }}
            />
          )}
          {buying && (
            <p className="py-6 text-center text-[13px] text-zinc-500">Buying your ticket…</p>
          )}
          {buyError && <p className="py-3 text-center text-[13px] text-red-400">{buyError}</p>}

          <div className="divide-y divide-zinc-800/60">
            {visiblePosts.map((post) => {
              const isRoot = post.parent_id === null;
              return (
                <article key={post.id} className={`py-3.5 ${isRoot ? "" : "pl-4"}`}>
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex-1 min-w-0 ${isRoot ? "" : "border-l border-zinc-800 pl-3"}`}
                    >
                      <PostContent
                        post={post}
                        tickerSupply={tickerSupply}
                        onOpenTicker={onOpenTicker}
                      />
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

            {/* ⚠ WHAT THE WORD HAS COME TO MEAN, read from how people use it.
                Written by the ticker's agent from the corpus, not from its own
                opinion, and stored as revisable metadata rather than an inscribed
                post — a meaning that cannot change is not a meaning. See
                TOKENS.md "A keyword is a living definition". Absent until the
                corpus can support one; an honest silence beats a confident
                definition drawn from two posts. */}
            {anchor && (
              <div className="mx-4 mt-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">The word</p>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{anchor.text}</p>
                {anchor.url && (
                  <a
                    href={anchor.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-block text-[10px] text-zinc-600 underline underline-offset-2 hover:text-zinc-400"
                  >
                    Wikipedia · CC BY-SA
                  </a>
                )}
              </div>
            )}

            {meaning && (
              <div className="mx-4 mb-1 mt-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.03] px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-widest text-amber-400/60">
                  What this word means here
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-300">{meaning}</p>
                <p className="mt-1.5 text-[10px] text-zinc-600">
                  Written from how people use it. It changes as they do.
                </p>
              </div>
            )}

            {/* ⚠ WHAT THIS NAME HAS SAID, not just where it was first written.
                A `$Nym` names a speaker, and everything a speaker says lives as
                replies in OTHER people's threads — so an agent that answered
                every question put to it showed "No replies yet" on its own page.
                Only rendered when the ticker is a claimed nym; a topic ticker
                returns nothing and this stays invisible. */}
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

      {/* Same keyboard-collapse `group` treatment as the feed's compose area.
          NO safe-area padding of its own any more — the tab bar below carries it
          now, and doubling it left a band of empty black under the composer. */}
      {/* ⚠ NO COMPOSER AT A DOOR YOU HAVE NOT PAID. `createPost` would refuse
          the reply anyway (the write gate is signature-verified), so offering
          the box would only invite somebody to type something that cannot be
          sent. */}
      {!locked && !accessUnknown && (
        <div className="shrink-0">
          <div className="group mx-auto max-w-2xl px-4 pb-3 pt-2 transition-all duration-200 pointer-coarse:has-[textarea:focus,.compose-send:focus]:pb-2">
            <PostForm
              parentId={rootId}
              compact
              placeholder="Reply…"
              onPostCreated={handleReplyCreated}
              onPostRejected={handleReplyRejected}
            />
          </div>
        </div>
      )}

      {/* ⚠ THE TAB BAR BELONGS HERE TOO. This overlay covers the whole viewport
          — including the bar the rest of the app keeps — so opening a thread
          used to strand the reader with one exit, the back arrow, and no way to
          reach the wallet, the market or the agent without leaving first. The
          owner asked for it back on these URLs.

          INSIDE the overlay's own flex column, not showing through from behind:
          the overlay sits at z-[60] precisely so the fixed bar could not paint
          over the reply composer (that bug hid it completely in the installed
          PWA). As the last row of this column the bar cannot overlap anything,
          and the composer above it stays clear of the home indicator because the
          bar carries the safe-area padding. */}
      {selling && position && (
        <SellModal
          symbol={position.symbol}
          held={position.units}
          onClose={() => setSelling(false)}
          onChanged={refreshAccess}
        />
      )}

      <BottomNav />
    </div>
  );
}
