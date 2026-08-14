"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BootToast } from "@/components/BootToast";
import { HomeScreenWelcomeGate } from "@/components/HomeScreenWelcomeGate";
import { InAppPromptModal } from "@/components/InAppPromptModal";
import { InstallPitch } from "@/components/InstallPitch";
import { IosStorageToast } from "@/components/IosStorageToast";
import { SignInModal } from "@/components/SignInModal";
import { BootProvider, useBootContext } from "@/contexts/BootContext";
import { IdentityProvider, useIdentityContext } from "@/contexts/IdentityContext";
import { InstallProvider } from "@/contexts/InstallContext";
import { useFeedPolling } from "@/hooks/useFeedPolling";
import { useScrollTracker } from "@/hooks/useScrollTracker";
import { timeAgo } from "@/lib/utils";
import type { BootboardData, Post } from "@/types";
import { getForwardPosts, getOlderPosts, getOldestPosts } from "./actions";
import { Bootboard } from "./Bootboard";
import { FundAddress } from "./FundAddress";
import { Header } from "./Header";
import { PostForm } from "./PostForm";
import { PostList } from "./PostList";
import { ThreadView } from "./ThreadView";

// Landing scroll must run before paint (else a flash at the wrong position).
// useLayoutEffect warns on the server; fall back to useEffect there.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type FeedMode = "live" | "origin";

// A post that was added optimistically before the server confirms it.
interface OptimisticPost {
  id: number; // temporary timestamp ID
  content: string;
  author_name: string;
  created_at: string;
  failed?: boolean;
  failReason?: string;
}

// Remove an optimistic post if a confirmed server post with matching content +
// author already exists.
function pruneOptimistic(optimisticPosts: OptimisticPost[], serverPosts: Post[]): OptimisticPost[] {
  return optimisticPosts.filter(
    (op) =>
      !serverPosts.some((sp) => sp.content === op.content && sp.author_name === op.author_name)
  );
}

// Inner component — lives inside IdentityProvider so it can access identity context.
function FeedContent({
  initialPosts,
  initialBootboard,
}: {
  initialPosts: Post[];
  initialBootboard: BootboardData;
}) {
  const { identity, requestSaveRecovery } = useIdentityContext();
  const { bootError } = useBootContext();

  // LIVE (newest, default) vs ORIGIN (oldest → read forward). `fading` drives the
  // cross-fade between them.
  const [mode, setMode] = useState<FeedMode>("live");
  const [fading, setFading] = useState(false);

  const {
    posts: serverPosts,
    bootboard,
    refresh,
  } = useFeedPolling({
    initialPosts,
    initialBootboard,
    intervalMs: 5000,
    paused: mode === "origin",
  });

  const [optimisticPosts, setOptimisticPosts] = useState<OptimisticPost[]>([]);
  const [agentHighlight, setAgentHighlight] = useState(false);
  // Default to floor price and 0 free boots — corrected from server once identity loads.
  const [bootPrice, setBootPrice] = useState(1000);
  const [freeBootsRemaining, setFreeBootsRemaining] = useState(0);
  const [showFundModal, setShowFundModal] = useState(false);
  // Open thread overlay (THREADS.md step 4). An overlay, NOT a third feed mode —
  // the feed's scroll machinery is left completely untouched while it is open,
  // so closing it needs no restoration. See ThreadView's header comment.
  const [threadRootId, setThreadRootId] = useState<number | null>(null);
  const [userAddress, setUserAddress] = useState("");
  const [userBalance, setUserBalance] = useState<number | undefined>(undefined);
  // Network fee the boot tx needs on top of bootPrice (from the tx builder on an
  // insufficient-funds result) — so the deposit modal's top-up math is exact.
  const [fundFee, setFundFee] = useState<number | undefined>(undefined);

  // ORIGIN forward-load state (scroll DOWN → load newer → append; jank-free).
  const [originPosts, setOriginPosts] = useState<Post[]>([]);
  const [originHasMore, setOriginHasMore] = useState(false);
  const [isLoadingForward, setIsLoadingForward] = useState(false);
  const fwdLoadingRef = useRef(false); // synchronous in-flight lock
  const originHasMoreRef = useRef(false);
  const lastOriginIdRef = useRef<number | undefined>(undefined);
  const fwdSentinelRef = useRef<HTMLDivElement>(null);
  const loadForwardRef = useRef<() => void>(() => {});

  // LIVE upward-load state (scroll UP → prepend older; bottom-relative anchor).
  const [olderPosts, setOlderPosts] = useState<Post[]>([]);
  // fewer than a full initial window ⇒ post #1 is already loaded (no older remain).
  const [liveHasMore, setLiveHasMore] = useState(() => initialPosts.length >= 100);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const olderLoadingRef = useRef(false); // synchronous in-flight lock
  const liveHasMoreRef = useRef(liveHasMore);
  const olderPostsRef = useRef<Post[]>(olderPosts);
  const oldestServerIdRef = useRef(0);
  const serverPostsRef = useRef<Post[]>(serverPosts);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const loadOlderRef = useRef<() => void>(() => {});
  const landedRef = useRef(false); // gates loadOlder until the first landing runs
  const modeRef = useRef<FeedMode>(mode);
  // scrollHeight captured immediately before a prepend / Genesis-reveal commit.
  // null on every other commit — so the anchor effect skips poll appends.
  const prependPrevHeightRef = useRef<number | null>(null);

  // Fetch the real boot status for this identity from the server once on load.
  useEffect(() => {
    if (!identity?.address) return;
    fetch(`/api/boot-status?pubkey=${encodeURIComponent(identity.address)}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.freeBootsRemaining === "number") {
          setFreeBootsRemaining(data.freeBootsRemaining);
        }
        if (typeof data.bootPrice === "number" && data.bootPrice > 0) {
          setBootPrice(data.bootPrice);
        }
      })
      .catch(() => {
        // Fall back to default values — free boots will just be 0 (conservative)
      });
  }, [identity?.address]);

  // Prune confirmed posts on every render — no extra effect needed.
  const pendingOptimistic = useMemo(
    () => pruneOptimistic(optimisticPosts, serverPosts),
    [optimisticPosts, serverPosts]
  );

  const handlePostRejected = useCallback((tempId: number, reason?: string) => {
    // Mark as failed, then auto-remove after 3 seconds
    setOptimisticPosts((prev) =>
      prev.map((op) => (op.id === tempId ? { ...op, failed: true, failReason: reason } : op))
    );
    setTimeout(() => {
      setOptimisticPosts((prev) => prev.filter((op) => op.id !== tempId));
    }, 3000);
  }, []);

  const handlePostCreated = useCallback(
    (content: string, author: string, tempId: number) => {
      setOptimisticPosts((prev) => [
        {
          id: tempId,
          content,
          author_name: author,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      // Poll 500ms after posting to confirm quickly
      setTimeout(refresh, 500);
    },
    [refresh]
  );

  // Decrement local free boots count after a free boot is used.
  const handleFreeBootUsed = useCallback(() => {
    setFreeBootsRemaining((prev) => Math.max(0, prev - 1));
  }, []);

  // LIVE list = prepended older history (ASC) + the newest window (ASC).
  const newestAsc = useMemo(() => [...serverPosts].reverse(), [serverPosts]);
  const liveList = useMemo(() => [...olderPosts, ...newestAsc], [olderPosts, newestAsc]);
  const renderedPosts = mode === "live" ? liveList : originPosts;
  const postIds = useMemo(() => serverPosts.map((p) => p.id), [serverPosts]);
  // Oldest post of the newest (server-polled) window. Stable: the poll only
  // prepends NEWER posts, so serverPosts.at(-1) never changes. Everything with a
  // smaller id is prepended history (never observed for unread — see PostList).
  const oldestServerId = newestAsc[0]?.id ?? 0;

  // Keep synchronous refs in step for the async loadOlder callback + mode-switch reset.
  liveHasMoreRef.current = liveHasMore;
  olderPostsRef.current = olderPosts;
  oldestServerIdRef.current = oldestServerId;
  serverPostsRef.current = serverPosts;
  modeRef.current = mode;

  // Returning-user "unread line" — computed ONCE at first client render and frozen,
  // so the divider position stays stable as the poll adds newer posts.
  const lastReadIdRef = useRef<number | null | undefined>(undefined);
  if (lastReadIdRef.current === undefined) {
    const raw =
      typeof window !== "undefined" ? localStorage.getItem("opencook_last_read_id") : null;
    lastReadIdRef.current = raw ? Number(raw) : null;
  }
  const firstUnreadIdRef = useRef<number | undefined>(undefined);
  const unreadFrozenRef = useRef(false);
  if (!unreadFrozenRef.current) {
    unreadFrozenRef.current = true;
    const lastRead = lastReadIdRef.current;
    if (lastRead != null && serverPosts.length > 0) {
      const asc = [...serverPosts].reverse();
      // Only when the boundary is INSIDE the loaded window (asc[0] is the oldest
      // loaded). Away > a window → land at newest, no divider.
      if (lastRead >= asc[0].id) firstUnreadIdRef.current = asc.find((p) => p.id > lastRead)?.id;
    }
  }

  const {
    scrollRef,
    bottomRef,
    genesisRef,
    observerRef,
    isAtBottom,
    isAtTop,
    unreadCount,
    genesisVisited,
    genesisHydrated,
    scrollToBottom,
    markJustPosted,
  } = useScrollTracker({
    postCount: serverPosts.length,
    postIds,
    trackUnread: mode === "live",
  });

  const isAtBottomRef = useRef(isAtBottom);
  isAtBottomRef.current = isAtBottom;

  // ORIGIN: auto-load NEWER posts as the user scrolls DOWN. Append only — no
  // prepend, no scroll-anchor compensation, so it's naturally smooth.
  const loadForward = useCallback(async () => {
    if (fwdLoadingRef.current || !originHasMoreRef.current) return;
    const cursor = lastOriginIdRef.current;
    if (cursor == null) return;
    fwdLoadingRef.current = true;
    setIsLoadingForward(true);
    try {
      const page = await getForwardPosts(cursor); // ASC
      setOriginPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.filter((p) => !seen.has(p.id))];
      });
      setOriginHasMore(page.length === 100);
      if (page.length) lastOriginIdRef.current = page[page.length - 1].id;
    } finally {
      fwdLoadingRef.current = false;
      setIsLoadingForward(false);
    }
  }, []);
  useEffect(() => {
    originHasMoreRef.current = originHasMore;
  }, [originHasMore]);
  useEffect(() => {
    loadForwardRef.current = loadForward;
  }, [loadForward]);

  // Forward sentinel at the BOTTOM of the origin list. Re-attaches when mode flips
  // (the sentinel only renders in ORIGIN mode).
  useEffect(() => {
    if (mode !== "origin") return; // sentinel only renders in ORIGIN mode
    const root = scrollRef.current;
    const target = fwdSentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadForwardRef.current();
      },
      { root, rootMargin: "0px 0px 800px 0px", threshold: 0 }
    );
    io.observe(target);
    return () => io.disconnect();
  }, [scrollRef, mode]);

  // LIVE: auto-load OLDER posts as the user scrolls UP → prepend ahead of them.
  // Bottom-relative scroll restoration keeps the visible content stationary.
  const loadOlder = useCallback(async () => {
    if (olderLoadingRef.current || !liveHasMoreRef.current) return;
    if (modeRef.current !== "live" || !landedRef.current) return; // never in origin / pre-landing
    const el = scrollRef.current;
    if (!el) return;
    const cursor = olderPostsRef.current.length
      ? olderPostsRef.current[0].id
      : oldestServerIdRef.current;
    if (!cursor || cursor <= 1) {
      setLiveHasMore(false);
      return;
    }
    olderLoadingRef.current = true; // sync lock BEFORE the await
    setIsLoadingOlder(true);
    try {
      const page = await getOlderPosts(cursor); // DESC, id < cursor, LIMIT 100
      // Capture height synchronously, immediately before ANY above-viewport
      // mutation (prepend AND/OR the Genesis reveal). No await below — nothing
      // can interleave.
      prependPrevHeightRef.current = el.scrollHeight;
      if (page.length === 0) {
        setLiveHasMore(false); // reveals Genesis → anchored via the liveHasMore key
        return;
      }
      const asc = [...page].reverse(); // ASC for prepend
      setOlderPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...asc.filter((p) => !seen.has(p.id)), ...prev];
      });
      if (page.length < 100) setLiveHasMore(false); // last page → Genesis caps the top
    } finally {
      olderLoadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [scrollRef]);
  useEffect(() => {
    loadOlderRef.current = loadOlder;
  }, [loadOlder]);

  // Bottom-relative anchor. Keyed on olderPosts AND liveHasMore so BOTH the
  // prepend commit and the sentinel→Genesis reveal commit are compensated. NOT
  // keyed on serverPosts, so 5s poll bottom-appends skip it (prependPrevHeightRef
  // is null on those commits). Pre-paint so there's no flash.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const before = prependPrevHeightRef.current;
    if (before == null) return; // not a prepend / reveal commit
    prependPrevHeightRef.current = null;
    el.scrollTop += el.scrollHeight - before;
  }, [olderPosts, liveHasMore]);

  // Top sentinel — LIVE only, and only while older history remains (mutually
  // exclusive with the founding block). Large TOP rootMargin fires the load
  // ~1000px BEFORE the physical top so the fetch+prepend+anchor settle off-screen
  // (the key iOS momentum/rubber-band defense).
  useEffect(() => {
    if (mode !== "live" || !liveHasMore) return;
    const root = scrollRef.current;
    const target = topSentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlderRef.current();
      },
      { root, rootMargin: "1000px 0px 0px 0px", threshold: 0 }
    );
    io.observe(target);
    return () => io.disconnect();
  }, [scrollRef, mode, liveHasMore]);

  // "Genesis" → ORIGIN: cross-fade out, load the oldest window, land at the top,
  // fade in. A ~220ms floor keeps a fast fetch from flickering.
  const handleGoOrigin = useCallback(async () => {
    if (fading) return;
    setFading(true);
    const started = Date.now();
    const oldest = await getOldestPosts();
    const wait = 220 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    setOriginPosts(oldest);
    setOriginHasMore(oldest.length === 100);
    originHasMoreRef.current = oldest.length === 100;
    lastOriginIdRef.current = oldest.at(-1)?.id;
    setMode("origin");
    requestAnimationFrame(() => setFading(false));
  }, [fading]);

  // "↓ Latest" → LIVE: cross-fade back to a CLEAN newest window (scroll-up state
  // does not persist across a Genesis round-trip).
  const handleGoLive = useCallback(async () => {
    if (fading) return;
    setFading(true);
    await new Promise((r) => setTimeout(r, 180));
    setOlderPosts([]);
    const hasMore = serverPostsRef.current.length >= 100;
    setLiveHasMore(hasMore);
    liveHasMoreRef.current = hasMore;
    olderPostsRef.current = [];
    prependPrevHeightRef.current = null;
    landedRef.current = false; // re-gate loadOlder until the landing effect re-runs
    setMode("live");
    requestAnimationFrame(() => setFading(false));
  }, [fading]);

  // Landing (pre-paint): ORIGIN → top; LIVE → bottom, except the very first mount
  // lands on the returning-user's first unread post when there is one.
  const didMountRef = useRef(false);
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (mode === "origin") {
      el.scrollTop = 0;
      return;
    }
    if (!didMountRef.current) {
      didMountRef.current = true;
      const fu = firstUnreadIdRef.current;
      if (fu != null) {
        const target = el.querySelector(`[data-post-id="${fu}"]`) as HTMLElement | null;
        if (target) {
          el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
          landedRef.current = true; // allow upward infinite-scroll now that we've landed
          return;
        }
      }
    }
    el.scrollTop = el.scrollHeight;
    landedRef.current = true; // allow upward infinite-scroll now that we've landed
  }, [mode]);

  // Persist the newest-seen id whenever the user is caught up (at the live bottom).
  useEffect(() => {
    if (mode !== "live" || !isAtBottom || serverPosts.length === 0) return;
    localStorage.setItem("opencook_last_read_id", String(serverPosts[0].id));
  }, [isAtBottom, mode, serverPosts]);
  useEffect(() => {
    const save = () => {
      if (mode === "live" && isAtBottomRef.current && serverPosts.length > 0) {
        localStorage.setItem("opencook_last_read_id", String(serverPosts[0].id));
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mode, serverPosts]);

  // When the user posts, their optimistic post appears at the bottom — scroll to
  // it and stick there through the ~500ms confirmation (markJustPosted). Other
  // users' posts never yank the scroll (they go to the unread badge). (QA 2026-06-23)
  const prevOptimisticLen = useRef(optimisticPosts.length);
  useEffect(() => {
    if (optimisticPosts.length > prevOptimisticLen.current) markJustPosted();
    prevOptimisticLen.current = optimisticPosts.length;
  }, [optimisticPosts.length, markJustPosted]);

  // iOS Safari scroll-compositor warmup. iOS's auto-scroll-into-view (which
  // brings the focused textarea above the soft keyboard) skips its
  // scroll-target search if the page has never had a real scroll event.
  // A 1px scroll-and-revert on mount wakes the compositor invisibly so every
  // textarea tap from then on triggers iOS's keyboard adjustment.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy(0, 1);
    el.scrollBy(0, -1);
  }, [scrollRef]);

  const handleAskAgent = useCallback(() => {
    scrollToBottom();
    setAgentHighlight(true);
    setTimeout(() => setAgentHighlight(false), 2000);
  }, [scrollToBottom]);

  // The ↓ pill returns to LIVE in origin mode, else jumps to the newest.
  const handleDownButton = mode === "origin" ? handleGoLive : scrollToBottom;

  return (
    <div className="flex flex-col h-[100dvh]">
      <Header
        isAtTop={isAtTop}
        genesisHydrated={genesisHydrated}
        genesisVisited={genesisVisited}
        onScrollToGenesis={handleGoOrigin}
      />

      {/* Pinned bootboard */}
      <div className="shrink-0 relative">
        <div className="mx-auto max-w-2xl px-4 pt-2 pb-3">
          <Bootboard
            data={bootboard}
            onBooted={refresh}
            bootPrice={bootPrice}
            onFundNeeded={(address, balance, fee) => {
              setUserAddress(address);
              setUserBalance(balance);
              setFundFee(fee);
              setShowFundModal(true);
            }}
          />
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-3 bg-gradient-to-b from-transparent to-black pointer-events-none" />
      </div>

      {/* Scrollable posts area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-y-contain relative scrollbar-hide"
        style={{ scrollbarWidth: "none" }}
      >
        {/* Cross-fade between LIVE and ORIGIN — opacity only, no scroll animation. */}
        <div className={`transition-opacity duration-200 ${fading ? "opacity-0" : "opacity-100"}`}>
          <PostList
            posts={renderedPosts}
            mode={mode}
            firstUnreadId={mode === "live" ? firstUnreadIdRef.current : undefined}
            genesisRef={genesisRef}
            bottomRef={bottomRef}
            observerRef={observerRef}
            fwdSentinelRef={fwdSentinelRef}
            originHasMore={originHasMore}
            isLoadingForward={isLoadingForward}
            topSentinelRef={topSentinelRef}
            liveHasMore={liveHasMore}
            isLoadingOlder={isLoadingOlder}
            oldestServerId={oldestServerId}
            onBooted={refresh}
            onAskAgent={handleAskAgent}
            onFundNeeded={(address, balance, fee) => {
              setUserAddress(address);
              setUserBalance(balance);
              setFundFee(fee);
              setShowFundModal(true);
            }}
            onFreeBootUsed={handleFreeBootUsed}
            bootPrice={bootPrice}
            freeBootsRemaining={freeBootsRemaining}
            onOpenThread={setThreadRootId}
          />

          {/* Optimistic posts — appear at the bottom (newest), full opacity since server confirms in ~50ms */}
          {mode === "live" && pendingOptimistic.length > 0 && (
            <div className="mx-auto max-w-2xl px-4 pb-2 divide-y divide-zinc-800/60">
              {pendingOptimistic.map((op) => (
                <article key={op.id} className={`py-3.5 ${op.failed ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
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
                                    : "Failed to post"}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[15px] leading-relaxed text-zinc-200 whitespace-pre-wrap break-words">
                        {op.content}
                      </p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ↓ pill — jump to newest (live) or back to latest (origin) */}
      {(mode === "origin" || !isAtBottom) && (
        <div className="shrink-0 flex justify-end mx-auto max-w-2xl px-4">
          <button
            type="button"
            onClick={handleDownButton}
            aria-label={mode === "origin" ? "Back to latest" : "Scroll to bottom"}
            className="relative -mb-5 z-30 w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800 border border-zinc-700 shadow-lg hover:bg-zinc-700 transition-colors mr-2"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="text-zinc-300"
            >
              <path
                d="M8 3v10m0 0l-4-4m4 4l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -top-2 -right-1 min-w-[20px] h-5 flex items-center justify-center rounded-full bg-amber-500 text-black text-[11px] font-bold px-1.5">
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Pinned bottom — compose area */}
      <div className="shrink-0">
        {/* Install pitch banner — full-width slide-up sheet above the compose.
            Self-gates via the 5-condition `shouldShowInstallPitch`: backed up,
            protected, not standalone, supported platform, not engaged. The
            chevron-tap minimises to the bookmark in PostForm (no timer-based
            suppression — see DECISIONS.md "Install pitch surfaces — no
            timer-based dismissal"). */}
        <InstallPitch variant="banner" />

        {/* `group` + pointer-coarse:group-focus-within drives the dock-to-keyboard
            collapse: on touch devices, focusing the textarea (= keyboard open)
            collapses the rows BELOW the input (the Ask-AI/bookmark grid in
            PostForm + this attribution) so the text box drops onto the keyboard.
            Pure CSS (:focus-within), no JS/visualViewport — so no lag. Desktop
            (fine pointer) is unaffected. (#6-adjacent compose UX, 2026-06-25) */}
        <div className="group mx-auto max-w-2xl px-4 pb-4 pt-2 transition-all duration-200 pointer-coarse:has-[textarea:focus,.compose-send:focus]:pb-2">
          <PostForm
            onPostCreated={handlePostCreated}
            onPostRejected={handlePostRejected}
            agentHighlight={agentHighlight}
          />
          {/* Attribution — centered. Install bookmark moved to PostForm row
              next to the Ask AI button (2026-06-03), so this row is just the
              bopen.ai link now. Collapses with the keyboard (see group above). */}
          <div className="flex justify-center mt-1 max-h-6 overflow-hidden opacity-100 transition-all duration-200 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:mt-0 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:max-h-0 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:opacity-0">
            <a
              href="https://bopen.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-zinc-700 hover:text-zinc-500 transition-colors"
            >
              created with bopen.ai
            </a>
          </div>
        </div>
      </div>

      {/* Fund address modal */}
      {showFundModal && userAddress && (
        <FundAddress
          address={userAddress}
          bootPrice={bootPrice}
          balance={userBalance}
          fee={fundFee}
          onClose={() => {
            setShowFundModal(false);
            setUserBalance(undefined);
            setFundFee(undefined);
          }}
          onSecure={requestSaveRecovery}
        />
      )}

      {/* Thread overlay — mounts OVER the feed, which keeps running underneath
          (the 5s poll included). Keyed on the root id so switching threads
          remounts with clean state rather than briefly showing the old one. */}
      {threadRootId !== null && (
        <ThreadView
          key={threadRootId}
          rootId={threadRootId}
          bootPrice={bootPrice}
          freeBootsRemaining={freeBootsRemaining}
          onClose={() => setThreadRootId(null)}
          onBooted={refresh}
          onFundNeeded={(address, balance, fee) => {
            setUserAddress(address);
            setUserBalance(balance);
            setFundFee(fee);
            setShowFundModal(true);
          }}
          onFreeBootUsed={handleFreeBootUsed}
        />
      )}

      {/* Boot failure toast */}
      <BootToast message={bootError} />

      {/* iOS post-install ITP heads-up — fires once on first standalone launch
          (navigator.standalone === true). Mount point inside FeedContent
          guarantees post-welcome-gate sequencing per LAUNCH_PLAN #12. */}
      <IosStorageToast />
    </div>
  );
}

/**
 * Inner wrapper that reads identity context and renders either the welcome gate
 * (when standalone + no identity) or the full feed UI. The gate renders BEFORE
 * any feed UI mounts, so the IdentityBar / Header / PostForm never see a null
 * identity in the awaiting-gate state.
 */
function FeedOrWelcomeGate({
  initialPosts,
  initialBootboard,
}: {
  initialPosts: Post[];
  initialBootboard: BootboardData;
}) {
  const { awaitingWelcomeGate, acceptRestoredIdentity } = useIdentityContext();

  if (awaitingWelcomeGate) {
    return <HomeScreenWelcomeGate onRestore={acceptRestoredIdentity} />;
  }

  return <FeedContent initialPosts={initialPosts} initialBootboard={initialBootboard} />;
}

export function Feed({
  posts: initialPosts,
  bootboard: initialBootboard,
}: {
  posts: Post[];
  bootboard: BootboardData;
}) {
  return (
    <BootProvider>
      <IdentityProvider>
        <InstallProvider>
          <SignInModal />
          <InAppPromptModal />
          <FeedOrWelcomeGate initialPosts={initialPosts} initialBootboard={initialBootboard} />
        </InstallProvider>
      </IdentityProvider>
    </BootProvider>
  );
}
