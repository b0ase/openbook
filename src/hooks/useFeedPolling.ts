"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hasLink } from "@/lib/linkify";
import type { BootboardData, Post, PostPreviewUpdate } from "@/types";

interface FeedPollingResult {
  posts: Post[];
  bootboard: BootboardData;
  updated?: Post[];
  // Authoritative boot counts for already-confirmed visible posts, so counts
  // update live from ANY boot source (Bootboard re-boot, other users, server
  // wallet) — not just this client's own optimistic +1.
  counts?: { id: number; boot_count: number; reply_count: number }[];
  // Previews that finished unfurling after the client already had the post.
  previews?: PostPreviewUpdate[];
}

interface UseFeedPollingOptions {
  initialPosts: Post[];
  initialBootboard: BootboardData;
  intervalMs?: number;
  // When true (ORIGIN mode), stop merging server posts so the historical view
  // isn't disturbed by newest-post polling. Resumes when unpaused.
  paused?: boolean;
}

export function useFeedPolling({
  initialPosts,
  initialBootboard,
  intervalMs = 5000,
  paused = false,
}: UseFeedPollingOptions) {
  const [posts, setPosts] = useState<Post[]>(initialPosts);
  const [bootboard, setBootboard] = useState<BootboardData>(initialBootboard);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Tracks the highest post id we have seen — null means first poll hasn't run yet
  const latestIdRef = useRef<number | null>(initialPosts.length > 0 ? initialPosts[0].id : null);
  // Keep a ref to current posts so we can read them in the async poll callback
  const postsRef = useRef<Post[]>(initialPosts);
  postsRef.current = posts;

  const fetchFeed = useCallback(async () => {
    if (isFetchingRef.current || pausedRef.current) return;
    isFetchingRef.current = true;
    try {
      const latestId = latestIdRef.current;

      // Build the poll URL with pending_tx param for posts missing chain confirmation
      let url = latestId !== null ? `/api/posts?since_id=${latestId}` : "/api/posts";

      // Find posts the client has that are missing tx_id (no chain icon yet)
      // We ask the server if any of them have been confirmed since we last polled
      const pendingIds = postsRef.current
        .filter((p) => !p.tx_id)
        .map((p) => p.id)
        .slice(0, 50); // Cap to avoid huge URLs
      if (pendingIds.length > 0) {
        const separator = url.includes("?") ? "&" : "?";
        url += `${separator}pending_tx=${pendingIds.join(",")}`;
      }

      // Ask the server for authoritative boot + reply counts on visible posts, so
      // the displayed counts track activity from any source, not just our own.
      //
      // Deliberately NOT filtered to `tx_id`-confirmed posts (it used to be).
      // A post is replyable and bootable the instant it exists in the DB, which
      // is well before it anchors on-chain — under that filter a fresh post's
      // counts stayed frozen until its OP_RETURN landed, and stayed frozen
      // forever whenever `BSV_SERVER_WIF` is unset (local dev, or a paused
      // wallet). The ids are capped either way, so covering all visible posts
      // costs nothing extra.
      const countIds = postsRef.current.map((p) => p.id).slice(0, 100);
      if (countIds.length > 0) {
        const separator = url.includes("?") ? "&" : "?";
        url += `${separator}counts=${countIds.join(",")}`;
      }

      // Posts carrying a link whose unfurl had not landed when we received the
      // row. `preview_status` is the stop condition, not `preview_title` — a
      // recorded FAILURE is an answer, and keying on the title would leave every
      // unfetchable link polling for the life of the session.
      const previewIds = postsRef.current
        .filter((p) => !p.preview_status && hasLink(p.content))
        .map((p) => p.id)
        .slice(0, 50);
      if (previewIds.length > 0) {
        const separator = url.includes("?") ? "&" : "?";
        url += `${separator}previews=${previewIds.join(",")}`;
      }

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data: FeedPollingResult = await res.json();

      setBootboard(data.bootboard);

      // tx_id confirmations (posts that just gained a chain icon)
      const updatedMap =
        data.updated && data.updated.length > 0
          ? new Map(data.updated.map((p: Post) => [p.id, p.tx_id]))
          : null;
      // Authoritative boot AND reply counts for confirmed visible posts. Reply
      // counts have no other route to the client: a reply is not a root, so it
      // never arrives via `posts`, and `updated` only carries tx_id gains.
      const countsMap =
        data.counts && data.counts.length > 0 ? new Map(data.counts.map((c) => [c.id, c])) : null;
      // Previews that finished after we already had the post. Without this the
      // author watched their own link sit bare until a reload, with the preview
      // sitting in the database the whole time.
      const previewsMap =
        data.previews && data.previews.length > 0
          ? new Map(data.previews.map((v) => [v.id, v]))
          : null;

      // Patch an existing post with any tx_id confirmation, count or preview.
      const patch = (p: Post): Post => {
        let next = p;
        if (updatedMap) {
          const tx = updatedMap.get(p.id);
          if (tx && !p.tx_id) next = { ...next, tx_id: tx };
        }
        if (countsMap) {
          const c = countsMap.get(p.id);
          if (c) {
            if (c.boot_count !== p.boot_count) next = { ...next, boot_count: c.boot_count };
            if (c.reply_count !== p.reply_count) next = { ...next, reply_count: c.reply_count };
          }
        }
        if (previewsMap && !p.preview_status) {
          const v = previewsMap.get(p.id);
          // `id` dropped: it is the post's own, and spreading it back would be
          // harmless but says the wrong thing about what a preview is.
          if (v) {
            const { id: _id, ...fields } = v;
            next = { ...next, ...fields };
          }
        }
        return next;
      };

      if (data.posts.length === 0) {
        if (!updatedMap && !countsMap && !previewsMap) return; // nothing to patch
        setPosts((prev) => prev.map(patch));
        return;
      }

      // New posts (+ possible tx_id / count patches) — one atomic setPosts
      if (latestId === null) {
        setPosts(data.posts);
      } else {
        setPosts((prev) => [...data.posts, ...prev.map(patch)]);
      }

      // data.posts is ordered DESC, so index 0 is the newest
      const newMax = data.posts[0].id;
      if (latestIdRef.current === null || newMax > latestIdRef.current) {
        latestIdRef.current = newMax;
      }
    } catch {
      // Silently ignore network errors — stale data is fine
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    function schedule() {
      timerRef.current = setTimeout(async () => {
        // Only poll when the tab is visible
        if (document.visibilityState === "visible") {
          await fetchFeed();
        }
        schedule();
      }, intervalMs);
    }

    // Resume polling immediately when tab becomes visible again
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        fetchFeed();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchFeed, intervalMs]);

  return { posts, setPosts, bootboard, setBootboard, refresh: fetchFeed };
}
