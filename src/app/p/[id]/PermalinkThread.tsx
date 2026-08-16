"use client";

import { useCallback, useEffect, useState } from "react";
import { getAddenda, getThread } from "@/app/actions";
import { PostContent } from "@/app/PostContent";
import { PostForm } from "@/app/PostForm";
import { useIdentityContext } from "@/contexts/IdentityContext";
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
  const [addenda, setAddenda] = useState<Post[]>([]);
  const [composing, setComposing] = useState(false);
  const { identity } = useIdentityContext();
  // Only the author can append — the server enforces it; this just avoids
  // offering a control that would always be refused.
  const isMine = !!identity?.pubkey && identity.pubkey === post.pubkey;

  const refreshAddenda = useCallback(() => {
    setComposing(false);
    void getAddenda(post.id)
      .then(setAddenda)
      .catch(() => {});
  }, [post.id]);

  useEffect(() => {
    void getThread(rootId)
      .then(setThread)
      .catch(() => setThread([]));
  }, [rootId]);

  useEffect(() => {
    void getAddenda(post.id)
      .then(setAddenda)
      .catch(() => setAddenda([]));
  }, [post.id]);

  // Addenda are the author revising themselves; replies are other people
  // answering. Mixing them would make a correction look like a conversation.
  const addendumIds = new Set(addenda.map((a) => a.id));
  const replies = (thread ?? []).filter((p) => p.id !== post.id && !addendumIds.has(p.id));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5">
      <article className="border-b border-zinc-900 pb-5">
        <PostContent post={post} />

        {/* ⚠ ATTACHED TO THE POST, NOT LISTED BELOW IT. A post cannot be edited —
            it is anchored on-chain — so this is how a correction reaches anyone
            reading the original. Detaching it into a reply list would let someone
            read the mistake and never see the fix. */}
        {addenda.map((a) => (
          <aside
            key={a.id}
            className="mt-3 border-l-2 border-amber-500/40 bg-amber-500/[0.04] py-2 pl-3"
          >
            <p className="text-[10px] uppercase tracking-[0.14em] text-amber-500/80">
              Addendum by the author
            </p>
            <div className="mt-1">
              <PostContent post={a} />
            </div>
          </aside>
        ))}

        {isMine && (
          <div className="mt-3">
            {composing ? (
              <div className="rounded-lg border border-amber-500/30 p-2">
                <p className="mb-1 px-1 text-[10px] uppercase tracking-[0.14em] text-amber-500/80">
                  Addendum — appended, never an edit
                </p>
                <PostForm
                  parentId={post.id}
                  addendum
                  compact
                  placeholder="Correct or add to this post…"
                  onPostCreated={refreshAddenda}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="text-[12px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
              >
                Add a correction
              </button>
            )}
          </div>
        )}
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
