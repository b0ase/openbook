"use client";

import { useCallback, useEffect, useState } from "react";
import { getMyThreads } from "@/app/actions";
import { PostContent } from "@/app/PostContent";
import { ThreadView } from "@/app/ThreadView";
import { useIdentityContext } from "@/contexts/IdentityContext";
import type { Post } from "@/types";

/**
 * Every conversation this identity is part of.
 *
 * ⚠ THIS IS NOT PRIVATE CHAT, AND MUST NOT BE PRESENTED AS IT. bChat's fifth tab
 * is private group chat; nothing of the sort exists here, and a tab that implied
 * it did would be promising encryption this board does not have. What this shows
 * is the public threads you are in, gathered in one place — real content, no new
 * backend, and honest about being public. The copy says so out loud rather than
 * relying on the reader to infer it.
 *
 * ⚠ IDENTITY IS CLIENT-SIDE, WHICH IS WHY THIS IS A CLIENT COMPONENT. The signing
 * key lives in localStorage and never reaches the server, so "my threads" cannot
 * be resolved during server rendering — there is no session to read. The pubkey
 * is passed to a server action once it is known.
 *
 * A locked identity still lists threads: the pubkey is readable without the
 * passphrase, and reading has never required signing in (same rule as the feed
 * and the AI chat — see the sign-in section in CLAUDE.md). The gate is on the
 * reply composer inside `ThreadView`, where it already is.
 */
export function ThreadList({ directory }: { directory?: React.ReactNode }) {
  const { identity, isLoading } = useIdentityContext();
  const [threads, setThreads] = useState<Post[] | null>(null);
  const [openRootId, setOpenRootId] = useState<number | null>(null);
  /**
   * Boost pricing for the thread overlay.
   *
   * ⚠ FETCHED HERE RATHER THAN DEFAULTED TO ZERO. `ThreadView` shows a boost
   * button on every row, and a zero price would render a control that either
   * looks free or fails on tap. The feed reads the same endpoint for the same
   * reason; this tab opens the identical overlay and so needs the identical
   * numbers.
   */
  const [bootPrice, setBootPrice] = useState(0);
  const [freeBootsRemaining, setFreeBootsRemaining] = useState(0);

  const pubkey = identity?.pubkey ?? null;
  const address = identity?.address ?? null;

  useEffect(() => {
    if (!address) return;
    void fetch(`/api/boot-status?pubkey=${encodeURIComponent(address)}`)
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
        // A missing price leaves the overlay's boost button to its own guards.
      });
  }, [address]);

  const load = useCallback(() => {
    if (!pubkey) return;
    void getMyThreads(pubkey)
      .then(setThreads)
      .catch(() => setThreads([]));
  }, [pubkey]);

  useEffect(() => {
    if (!pubkey) {
      // Resolved and there is no identity yet — an empty list, not a spinner.
      if (!isLoading) setThreads([]);
      return;
    }
    load();
  }, [pubkey, isLoading, load]);

  // Refresh when the thread overlay closes: a reply just sent from inside it
  // changes both the ordering and the preview line on the row behind it.
  const closeThread = useCallback(() => {
    setOpenRootId(null);
    load();
  }, [load]);

  /**
   * Everything on the board, then everything of yours.
   *
   * The directory is rendered by the server and passed straight through — it
   * needs no identity, so it must not wait on one. A signed-out reader still
   * gets the full list of named threads instead of an empty page.
   */
  const yours = renderYours();
  return (
    <>
      {directory}
      <div className="border-t border-zinc-900 px-4 pb-1 pt-4">
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-zinc-600">Yours</h2>
      </div>
      {yours}
      {openRootId !== null && (
        <ThreadView
          rootId={openRootId}
          bootPrice={bootPrice}
          freeBootsRemaining={freeBootsRemaining}
          onClose={closeThread}
          onOpenThread={setOpenRootId}
        />
      )}
    </>
  );

  function renderYours() {
    if (threads === null) {
      return <p className="px-4 py-10 text-center text-sm text-zinc-600">Loading…</p>;
    }

    if (threads.length === 0) {
      return (
        <div className="px-6 py-16 text-center">
          <p className="text-sm text-zinc-400">No threads yet.</p>
          <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-zinc-600">
            Threads you start or reply to appear here, newest activity first.
          </p>
          <a
            href="/"
            className="mt-5 inline-block rounded-full border border-zinc-800 px-4 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white"
          >
            Go to the feed
          </a>
        </div>
      );
    }

    return (
      <ul className="divide-y divide-zinc-900">
        {threads.map((post) => (
          <li key={post.id}>
            {/* The whole row opens the thread. Unlike the feed there is no
                composer and no boost column here, so the row has nothing else it
                could mean — a plain button is honest and keyboard-reachable,
                where the feed needs a guarded click because its rows are full of
                other controls. */}
            <button
              type="button"
              onClick={() => setOpenRootId(post.root_id ?? post.id)}
              className="block w-full px-4 py-3.5 text-left transition-colors hover:bg-zinc-950"
            >
              <PostContent post={post} />
              <span className="mt-1.5 block text-[11px] text-zinc-600">
                {post.reply_count === 1 ? "1 reply" : `${post.reply_count ?? 0} replies`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
}
