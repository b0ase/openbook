"use client";

import { useEffect, useState } from "react";
import { getThread } from "@/app/actions";
import { PostContent } from "@/app/PostContent";
import type { Post } from "@/types";

/**
 * The permalinked post, with the conversation it belongs to beneath it.
 *
 * ⚠ THE POST IS RENDERED BY THE SERVER, THE THREAD ARRIVES AFTER. A stranger
 * following a link from Telegram must SEE the post in the HTML — that is what
 * makes it readable without an account and what a crawler indexes. The replies
 * are the elaboration and can load a beat later; the post itself never should.
 *
 * Same `PostContent` as the feed, so a shared post looks like itself: the same
 * colour, the same unfurl, the same media, the same fold on a long body.
 */
export function PermalinkThread({ post }: { post: Post }) {
  const rootId = post.root_id ?? post.id;
  const [thread, setThread] = useState<Post[] | null>(null);

  useEffect(() => {
    void getThread(rootId)
      .then(setThread)
      .catch(() => setThread([]));
  }, [rootId]);

  const replies = (thread ?? []).filter((p) => p.id !== post.id);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5">
      <article className="border-b border-zinc-900 pb-5">
        <PostContent post={post} />
      </article>

      {replies.length > 0 && (
        <>
          <h2 className="mt-5 text-[11px] uppercase tracking-[0.14em] text-zinc-600">
            {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
          </h2>
          <ul className="mt-2 divide-y divide-zinc-900">
            {replies.map((r) => (
              <li key={r.id} className="py-3.5">
                <PostContent post={r} />
              </li>
            ))}
          </ul>
        </>
      )}

      {thread !== null && replies.length === 0 && (
        <p className="mt-5 text-[13px] text-zinc-600">No replies yet.</p>
      )}

      <a
        href="/"
        className="mt-8 inline-block text-[12px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
      >
        ← Read the board
      </a>
    </div>
  );
}
