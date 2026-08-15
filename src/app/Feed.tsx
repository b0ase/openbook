"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BootToast } from "@/components/BootToast";
import { HomeScreenWelcomeGate } from "@/components/HomeScreenWelcomeGate";
import { InAppPromptModal } from "@/components/InAppPromptModal";
import { InstallPitch } from "@/components/InstallPitch";
import { IosStorageToast } from "@/components/IosStorageToast";
import { Notice } from "@/components/Notice";
import { SignInModal } from "@/components/SignInModal";
import { SupportAddress } from "@/components/SupportAddress";
import { BootProvider, useBootContext } from "@/contexts/BootContext";
import { IdentityProvider, useIdentityContext } from "@/contexts/IdentityContext";
import { InstallProvider } from "@/contexts/InstallContext";
import { useFeedPolling } from "@/hooks/useFeedPolling";
import { useScrollTracker } from "@/hooks/useScrollTracker";
import { FORK_POINT_ID, isInheritedPost } from "@/lib/fork-point";
import { readCachedNym } from "@/lib/nym-cache";
import {
  distinctTickers,
  isRootTicker,
  parseTickerPath,
  ROOT_HREF,
  tickerHref,
  titleCaseTicker,
} from "@/lib/ticker";
import { timeAgo } from "@/lib/utils";
import type { BootboardData, Post } from "@/types";
import {
  getForwardPosts,
  getOlderPosts,
  getOldestPosts,
  getTickerPath,
  getTickerSupply,
  resolveTickers,
} from "./actions";
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

/**
 * What a rejected post says to its author.
 *
 * ⚠ MONEY FAILURES MUST NOT READ AS "failed to post". Under paid posting the
 * author's own funds are involved, and a generic failure leaves them unsure
 * whether they were charged. Each of these happens BEFORE anything is
 * broadcast, so the honest message is that nothing was spent.
 */
const POST_FAILURE_TEXT: Record<string, string> = {
  rate_limited: "Too fast — try again",
  daily_limit: "Daily post limit reached",
  paused: "Posting briefly paused",
  rejected_content: "Can't be posted",
  // Paid posting — nothing was broadcast, so nothing was spent.
  insufficient_funds: "Not enough funds — add some and try again",
  no_utxos: "No funds yet — add some to post",
  broadcast_failed: "Couldn't reach the network — nothing was spent",
  payment_required: "This post needs funding",
  invalid_payment: "Payment didn't check out — nothing was stored",
};

// A post that was added optimistically before the server confirms it.
interface OptimisticPost {
  id: number; // temporary timestamp ID
  content: string;
  author_name: string;
  /**
   * The poster's `$Nym`, read from the local cache rather than the server.
   * Without it a brand-new post renders under `anon_xxxx` and flips to the nym
   * ~500ms later when the feed poll returns the real row — the one place the
   * user is guaranteed to be looking.
   */
  author_nym?: string | null;
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
  supportAddress,
}: {
  initialPosts: Post[];
  initialBootboard: BootboardData;
  supportAddress: string | null;
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
  /**
   * Why the last ticker click did not open a thread.
   *
   * ⚠ A CLICK THAT DOES NOTHING IS INDISTINGUISHABLE FROM A BROKEN SITE. Opening
   * a thread crosses the network, so it can fail for reasons the reader cannot
   * see — an unclaimed name, or a tab left open across a deploy whose server
   * actions no longer exist (the feed keeps polling through that, because it
   * goes through a route handler, so the page looks perfectly alive while every
   * ticker is dead until a reload).
   */
  const [tickerNotice, setTickerNotice] = useState<string | null>(null);
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
  /**
   * Tokens issued per ticker, for the `(n%)` beside each `$Ticker` in post text.
   *
   * Refreshed on the SAME cadence as the feed rather than on its own timer, so
   * the figure can never describe a different revision of the board than the
   * posts it is printed next to. Fetched for every symbol currently on screen in
   * one call — see `getTickerSupply` for why not one call per mention.
   */
  const [tickerSupply, setTickerSupply] = useState<Record<string, number>>({});
  const [olderPosts, setOlderPosts] = useState<Post[]>([]);
  // fewer than a full initial window ⇒ post #1 is already loaded (no older remain).
  const [liveHasMore, setLiveHasMore] = useState(() => initialPosts.length >= 100);
  /**
   * Whether the inherited OpenCook run-up is included in the feed.
   *
   * ⚠ FALSE BY DEFAULT AND THAT IS THE POINT. Posts up to the fork were written
   * on another board by other people; showing them inline presents them as this
   * board's own, which they are not. The ref shadows the state because the
   * loaders below run from callbacks and observers that would otherwise close
   * over a stale value — the same reason `liveHasMore` carries one.
   */
  const [showInherited, setShowInherited] = useState(false);
  const showInheritedRef = useRef(false);
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
          author_nym: readCachedNym(identity?.pubkey),
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      // Poll 500ms after posting to confirm quickly
      setTimeout(refresh, 500);
    },
    [refresh, identity?.pubkey]
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

  /**
   * Every ticker named by a post currently rendered.
   *
   * Derived with `distinctTickers`, the SAME matcher that decides what gets
   * claimed and what `PostText` renders — a second pattern here would eventually
   * ask for a symbol the renderer never draws, or miss one it does.
   */
  const visibleTickers = useMemo(() => {
    const all = new Set<string>();
    for (const p of renderedPosts) for (const t of distinctTickers(p.content)) all.add(t);
    return [...all].sort().join(",");
  }, [renderedPosts]);

  // Keyed on the JOINED symbol list, not the post array: scrolling loads posts
  // constantly but rarely introduces a new ticker, and this should not refetch
  // because a boot count moved.
  useEffect(() => {
    if (!visibleTickers) {
      setTickerSupply({});
      return;
    }
    let live = true;
    const symbols = visibleTickers.split(",");
    const load = () => {
      void getTickerSupply(symbols)
        .then((m) => {
          if (live) setTickerSupply(m);
        })
        .catch(() => {
          // A missing figure is a bracket that isn't drawn, not a broken feed.
        });
    };
    load();
    // Same 5s cadence as the feed poll, and skipped on a hidden tab for the same
    // reason: a backgrounded board should cost nothing.
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [visibleTickers]);
  // Oldest post of the newest (server-polled) window. Stable: the poll only
  // prepends NEWER posts, so serverPosts.at(-1) never changes. Everything with a
  // smaller id is prepended history (never observed for unread — see PostList).
  const oldestServerId = newestAsc[0]?.id ?? 0;

  // Keep synchronous refs in step for the async loadOlder callback + mode-switch reset.
  liveHasMoreRef.current = liveHasMore;
  showInheritedRef.current = showInherited;
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
      const page = await getForwardPosts(cursor, showInheritedRef.current); // ASC
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
    // Oldest row currently on screen. With the inherited run-up revealed on a
    // board that has NO posts of its own yet, there is no such row and no server
    // cursor either — so fall back to the fork boundary, which is exactly "older
    // than OpenBooks's first post". Without this the reveal silently loads
    // nothing on a fresh board, which is the state a new deploy is in.
    const cursor =
      olderPostsRef.current.length > 0
        ? olderPostsRef.current[0].id
        : oldestServerIdRef.current || (showInheritedRef.current ? FORK_POINT_ID + 1 : 0);
    if (!cursor || cursor <= 1) {
      setLiveHasMore(false);
      return;
    }
    olderLoadingRef.current = true; // sync lock BEFORE the await
    setIsLoadingOlder(true);
    try {
      const page = await getOlderPosts(cursor, showInheritedRef.current); // DESC, LIMIT 100
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

  /**
   * Show or hide the inherited OpenCook run-up above the fork marker.
   *
   * Showing re-opens the upward scroll: `liveHasMore` was set false when the
   * feed reached OpenBooks's first post, so it has to be reset or the sentinel
   * will never fire again. Hiding drops the inherited rows back out and closes
   * it again, so the two directions are symmetric and the feed cannot end up
   * holding rows it is no longer meant to show.
   *
   * Both paths write the REF before the state, because `loadOlder` reads the ref
   * and is invoked in the same tick — a state update would not have landed yet
   * and the first page would come back with the wrong era filter.
   */
  const toggleInherited = useCallback(async () => {
    const next = !showInheritedRef.current;
    showInheritedRef.current = next;
    setShowInherited(next);

    if (!next) {
      setOlderPosts((prev) => prev.filter((p) => !isInheritedPost(p.id)));
      olderPostsRef.current = olderPostsRef.current.filter((p) => !isInheritedPost(p.id));
      setLiveHasMore(false);
      liveHasMoreRef.current = false;
      return;
    }

    // ⚠ FETCHES DIRECTLY RATHER THAN CALLING `loadOlder`. That function is the
    // SCROLL path and is gated on `landedRef` — the feed having completed its
    // landing — which never becomes true on a board with no posts of its own.
    // Routing an explicit click through a scroll guard meant the toggle flipped
    // its label and loaded nothing, silently, in exactly the state a fresh
    // deploy is in. A deliberate tap is not a scroll and should not inherit its
    // preconditions.
    const el = scrollRef.current;
    const cursor =
      olderPostsRef.current.length > 0
        ? olderPostsRef.current[0].id
        : oldestServerIdRef.current || FORK_POINT_ID + 1;
    setIsLoadingOlder(true);
    try {
      const page = await getOlderPosts(cursor, true);
      // Captured immediately before the prepend, same contract as loadOlder:
      // the bottom-relative anchor keeps what the reader is looking at still.
      if (el) prependPrevHeightRef.current = el.scrollHeight;
      if (page.length === 0) {
        setLiveHasMore(false);
        liveHasMoreRef.current = false;
        return;
      }
      const asc = [...page].reverse();
      setOlderPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...asc.filter((p) => !seen.has(p.id)), ...prev];
      });
      const more = page.length === 100;
      setLiveHasMore(more);
      liveHasMoreRef.current = more;
    } finally {
      setIsLoadingOlder(false);
    }
  }, [scrollRef]);

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
    const oldest = await getOldestPosts(showInheritedRef.current);
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

  // `$Ticker` → the thread it names. Resolved on CLICK rather than pre-fetched
  // for every rendered post: a click is rare, a feed render is constant, and
  // resolving lazily keeps the ticker feature off the 5s poll entirely.
  const handleOpenTicker = useCallback(async (symbol: string) => {
    // The root's own name means the feed you are already looking at, so it goes
    // HOME rather than opening an overlay that would duplicate the feed behind
    // it — the same rule the breadcrumb's root crumb follows. Pushed only when
    // the address actually changes, so clicking `$OpenBooks` from the feed does
    // not stack a history entry whose Back does nothing visible.
    if (isRootTicker(symbol)) {
      setThreadRootId(null);
      if (window.location.pathname !== ROOT_HREF) {
        window.history.pushState({}, "", ROOT_HREF);
      }
      return;
    }
    setTickerNotice(null);

    // Resolved and traced TOGETHER: the path does not depend on the hit, and two
    // sequential round trips is a second of a click doing nothing visible, which
    // reads as a broken link just as much as an outright failure does.
    let resolved: Awaited<ReturnType<typeof resolveTickers>>;
    let path: string[];
    try {
      [resolved, path] = await Promise.all([resolveTickers([symbol]), getTickerPath(symbol)]);
    } catch {
      // ⚠ NEVER SWALLOW THIS. The usual cause is a tab held open across a deploy:
      // server-action ids are build-specific, so every action from a stale bundle
      // 404s while the feed — a route handler — keeps polling happily. Silently
      // returning left the reader clicking a link that would not open and no way
      // to know a reload was all it needed.
      setTickerNotice(`Couldn't open $${titleCaseTicker(symbol)} — try reloading the page.`);
      return;
    }

    const hit = resolved[symbol];
    if (!hit) {
      // An unclaimed symbol is a normal answer, not a fault — posts written
      // before the registry existed name tickers nobody ever registered. Said
      // out loud, because from the reader's side it is the same dead click.
      setTickerNotice(`$${titleCaseTicker(symbol)} hasn't been claimed yet — no thread to open.`);
      return;
    }

    setThreadRootId(hit.root_id);
    // Make the open thread addressable WITHOUT navigating: pushState changes the
    // URL and adds a history entry (so Back closes the thread) while leaving the
    // feed mounted. A real navigation would remount it and lose the scroll
    // position, which is the reason ThreadView is an overlay in the first place.
    window.history.pushState({ ticker: symbol }, "", tickerHref(path.length ? path : [symbol]));
  }, []);

  // The notice is transient — it explains one click, and must not sit over the
  // feed afterwards implying something is still wrong.
  useEffect(() => {
    if (!tickerNotice) return;
    const t = setTimeout(() => setTickerNotice(null), 4000);
    return () => clearTimeout(t);
  }, [tickerNotice]);

  // Close on Back, rather than letting Back leave the site while a thread is open.
  useEffect(() => {
    const onPop = () => {
      const fromUrl = parseTickerPath(window.location.pathname);
      const leaf = fromUrl.at(-1);
      // No ticker in the URL and the root's own name both mean the feed.
      if (!leaf || isRootTicker(leaf)) {
        setThreadRootId(null);
        return;
      }
      void resolveTickers([leaf]).then((r) => {
        const hit = r[leaf];
        setThreadRootId(hit ? hit.root_id : null);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A COLD LOAD of a shared `/$openbook/$test` link opens that thread. Runs once:
  // afterwards the URL is driven by pushState above.
  /**
   * Open the thread named by the URL on a cold load.
   *
   * The division is: `/` is the root — feed and root thread being the same view
   * — and `/$whatever` is any other thread. An unclaimed name resolves to
   * nothing and falls through to the feed anyway.
   *
   * ⚠ THE ROOT TICKER IS SPECIAL-CASED, and the reason the earlier rule went the
   * other way is worth keeping: while `handleOpenTicker` could push
   * `/$openbooks` for a claimed root, refusing to reopen it here would have let
   * you view a thread, copy its address, and send someone the feed — a URL that
   * does not reproduce what the sharer was looking at. That is fixed at the
   * source instead: `tickerHref` never mints `/$openbooks`, so the only address
   * for the root is `/`, and the two views it could point at are the same view.
   *
   * `/$openbooks` and the pre-plural `/$openbook` stay valid — the catch-all
   * route redirects them here, and this check is the client-side half for a URL
   * that arrives without a server round trip (an old tab's pushState, Back into
   * pre-redirect history).
   */
  const openedFromUrlRef = useRef(false);
  useEffect(() => {
    if (openedFromUrlRef.current) return;
    openedFromUrlRef.current = true;
    const leaf = parseTickerPath(window.location.pathname).at(-1);
    if (!leaf || isRootTicker(leaf)) return;
    void resolveTickers([leaf]).then((r) => {
      const hit = r[leaf];
      if (hit) setThreadRootId(hit.root_id);
    });
  }, []);

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
        onOpenThread={setThreadRootId}
      />

      {/* Published funding address — see SupportAddress for why this reverses the
          /api/health "never expose the address" rule, deliberately. */}
      <div className="shrink-0">
        <SupportAddress address={supportAddress} />
      </div>

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
            showInherited={showInherited}
            onToggleInherited={toggleInherited}
            tickerSupply={tickerSupply}
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
            onOpenTicker={handleOpenTicker}
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
                            {POST_FAILURE_TEXT[op.failReason ?? ""] ?? "Failed to post"}
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
          onOpenThread={setThreadRootId}
          bootPrice={bootPrice}
          freeBootsRemaining={freeBootsRemaining}
          onClose={() => {
            setThreadRootId(null);
            // Back to the root token's URL — the main feed IS $OpenBooks's thread,
            // and that thread's address is the bare site, not `/$openbooks`.
            window.history.pushState({}, "", ROOT_HREF);
          }}
          onBooted={refresh}
          onFundNeeded={(address, balance, fee) => {
            setUserAddress(address);
            setUserBalance(balance);
            setFundFee(fee);
            setShowFundModal(true);
          }}
          onFreeBootUsed={handleFreeBootUsed}
          onOpenTicker={handleOpenTicker}
        />
      )}

      {/* Boot failure toast */}
      <BootToast message={bootError} />

      {/* Why a ticker click did not open a thread. Below the boot toast in the
          tree but never both at once in practice — one follows a tap on a name,
          the other a tap on a boot. */}
      <Notice message={tickerNotice} />

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
  supportAddress,
}: {
  initialPosts: Post[];
  initialBootboard: BootboardData;
  supportAddress: string | null;
}) {
  const { awaitingWelcomeGate, acceptRestoredIdentity } = useIdentityContext();

  if (awaitingWelcomeGate) {
    return <HomeScreenWelcomeGate onRestore={acceptRestoredIdentity} />;
  }

  return (
    <FeedContent
      initialPosts={initialPosts}
      initialBootboard={initialBootboard}
      supportAddress={supportAddress}
    />
  );
}

export function Feed({
  posts: initialPosts,
  bootboard: initialBootboard,
  supportAddress,
}: {
  posts: Post[];
  bootboard: BootboardData;
  supportAddress: string | null;
}) {
  return (
    <BootProvider>
      <IdentityProvider>
        <InstallProvider>
          <SignInModal />
          <InAppPromptModal />
          <FeedOrWelcomeGate
            initialPosts={initialPosts}
            initialBootboard={initialBootboard}
            supportAddress={supportAddress}
          />
        </InstallProvider>
      </IdentityProvider>
    </BootProvider>
  );
}
