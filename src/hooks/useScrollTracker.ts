"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseScrollTrackerOptions {
  postCount: number;
  postIds: number[];
  // Unread tracking (per-article observer + badge) only makes sense in LIVE mode.
  // In ORIGIN mode it's off, which also removes the per-article observer cost.
  trackUnread: boolean;
}

interface UseScrollTrackerReturn {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  genesisRef: React.RefObject<HTMLDivElement | null>;
  observerRef: React.RefObject<IntersectionObserver | null>;
  isAtBottom: boolean;
  isAtTop: boolean;
  unreadCount: number;
  genesisVisited: boolean;
  genesisHydrated: boolean;
  scrollToBottom: () => void;
  scrollToGenesis: () => void;
  markJustPosted: () => void;
}

export function useScrollTracker({
  postCount,
  postIds,
  trackUnread,
}: UseScrollTrackerOptions): UseScrollTrackerReturn {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const genesisRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isAtTop, setIsAtTop] = useState(false);
  const [genesisVisited, setGenesisVisited] = useState(false);
  const [genesisHydrated, setGenesisHydrated] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const prevCountRef = useRef(postCount);
  const unreadIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (localStorage.getItem("openbook_genesis_visited") === "1") {
      setGenesisVisited(true);
    }
    setGenesisHydrated(true);
  }, []);

  const scrollToGenesis = useCallback(() => {
    genesisRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setUnreadCount(0);
  }, []);

  // Set when the LOCAL user posts. While recent, an incoming post-count change
  // (their optimistic post + its ~500ms server confirmation) scrolls to show it
  // instead of badging. Other users' polled posts (outside this window) never
  // yank the scroll — they accumulate in the unread badge. (QA 2026-06-23)
  const justPostedAtRef = useRef(0);
  const markJustPosted = useCallback(() => {
    justPostedAtRef.current = Date.now();
    requestAnimationFrame(() => scrollToBottom());
  }, [scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onScroll() {
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setIsAtBottom(atBottom);
      const atTop = el.scrollTop < 80;
      setIsAtTop(atTop);
      if (atTop && !genesisVisited) {
        setGenesisVisited(true);
        localStorage.setItem("openbook_genesis_visited", "1");
      }
      if (atBottom) setUnreadCount(0);
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [genesisVisited]);

  // Unread observer — LIVE mode only. Gating on trackUnread means ORIGIN mode
  // attaches ZERO per-article observers (the DOM-bound cost at depth).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !trackUnread) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      return;
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = Number(entry.target.getAttribute("data-post-id"));
            if (unreadIdsRef.current.has(id)) {
              unreadIdsRef.current.delete(id);
              changed = true;
            }
          }
        }
        if (changed) setUnreadCount(unreadIdsRef.current.size);
      },
      { root: container, threshold: 0.5 }
    );

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [trackUnread]);

  useEffect(() => {
    const newPosts = postCount - prevCountRef.current;
    prevCountRef.current = postCount;

    if (newPosts > 0 && trackUnread) {
      if (Date.now() - justPostedAtRef.current < 2500) {
        // The user just posted — keep them on their own post + its confirmation.
        requestAnimationFrame(() => scrollToBottom());
      } else {
        // Other users' polled posts NEVER yank the scroll — badge only. This is
        // the consistent behavior (the old isAtBottom check was unreliable once
        // the keyboard shrank the viewport, causing the reported flip-flop).
        for (let i = 0; i < newPosts; i++) {
          unreadIdsRef.current.add(postIds[i]);
        }
        setUnreadCount(unreadIdsRef.current.size);
      }
    }
  }, [postCount, postIds, scrollToBottom, trackUnread]);

  return {
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
    scrollToGenesis,
    markJustPosted,
  };
}
