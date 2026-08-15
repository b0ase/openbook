"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { InlineAgentTranscript } from "@/components/InlineAgentAnswer";
import { InstallBookmark } from "@/components/InstallBookmark";
import { PermanenceGate } from "@/components/PermanenceGate";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useMediaUpload } from "@/hooks/useMediaUpload";
import { useVoiceToText } from "@/hooks/useVoiceToText";
import { type AgentTurn, appendTurn, formatTranscript, hashTurn } from "@/lib/agent-record";
import { parseSlashCommand } from "@/lib/slash";
import { ACCEPTED_MIME } from "@/lib/upload";
import { AgentChat } from "./AgentChat";
import { createPost, getPostingMode } from "./actions";
import { TickerHint } from "./TickerHint";

interface PostFormProps {
  onPostCreated?: (content: string, author: string, tempId: number) => void;
  onPostRejected?: (tempId: number, reason?: string) => void;
  agentHighlight?: boolean;
  /**
   * Post as a REPLY to this post rather than starting a new thread
   * (THREADS.md). Undefined = a root post, which is the feed's compose box.
   *
   * The whole submit pipeline is shared deliberately: a reply is a post, so it
   * gets the same signing, the same permanence gate, the same sign-in gate and
   * the same on-chain anchoring. Forking a second composer would have meant two
   * places to keep those in step.
   */
  parentId?: number;
  /**
   * Drop the footer row (install bookmark, Ask AI, keyboard hint). Those belong
   * to the feed's primary compose box; inside a thread they are noise.
   */
  compact?: boolean;
  placeholder?: string;
}

export function PostForm({
  onPostCreated,
  onPostRejected,
  agentHighlight,
  parentId,
  compact,
  placeholder,
}: PostFormProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isPending, startTransition] = useTransition();
  const [hasContent, setHasContent] = useState(false);
  // Mirrored for the ticker hint. The textarea is uncontrolled (auto-grow writes
  // to it directly), so the hint needs its own copy of the text.
  const [draft, setDraft] = useState("");
  const [justPosted, setJustPosted] = useState(false);
  const [resumeNudge, setResumeNudge] = useState(false);
  const { identity, needsUnlock, sign, requireIdentity } = useIdentityContext();
  // Set when the user tries to submit while locked — drives a focus + amber
  // border pulse once identity arrives, so the user knows their draft is
  // waiting and can hit Enter to send.
  const wantedToPostRef = useRef(false);
  // One-time permanence acknowledgement gate, shown before the user's FIRST post.
  const [showPermanenceGate, setShowPermanenceGate] = useState(false);
  // The inline agent answer. Ephemeral — see InlineAgentAnswer for why it is
  // never posted.
  const [chain, setChain] = useState<AgentTurn[]>([]);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const pendingPostRef = useRef<{
    identity: NonNullable<typeof identity>;
    content: string;
  } | null>(null);

  // Insert transcribed voice text into the compose box. Appends to existing
  // content, re-runs the auto-grow, and CRITICALLY dispatches a native `input`
  // event so React's onInput fires — without it a direct `.value` write is
  // invisible to React, `hasContent` never flips, and the send button never
  // replaces the mic (the user couldn't send a dictated post). (mic rebuild 2026-06-25)
  const handleTranscript = useCallback((text: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.value = el.value ? `${el.value.trim()} ${text}` : text;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    // Hands-free on touch: don't auto-open the keyboard after dictation (the text
    // appears with the send button ready). On desktop (fine pointer, no on-screen
    // keyboard) keep the caret so the user can keep typing. Mirrors the
    // pointer:coarse check in handleKeyDown. (mic polish 2026-06-26)
    if (!window.matchMedia?.("(pointer: coarse)").matches) el.focus();
  }, []);

  // Record-and-transcribe mic (getUserMedia + MediaRecorder → /api/transcribe →
  // Groq Whisper). Replaces the Web Speech API, which is unfixable on iOS PWAs.
  // See DECISIONS.md "Mic: record + Groq Whisper".
  const {
    state: voiceState,
    error: voiceError,
    toggle: toggleMic,
    dismissError: dismissMicError,
  } = useVoiceToText(handleTranscript);

  // An uploaded file becomes a URL in the post text — the same thing a user gets
  // by pasting a link, so it renders through `MediaEmbed` and travels on-chain
  // inside the post with no new field, no schema change and no second render
  // path that could disagree with the linked-media one.
  const handleUploaded = useCallback(
    (url: string) => {
      handleTranscript(url);
    },
    [handleTranscript]
  );

  const {
    upload,
    pending: uploadPending,
    total: uploadTotal,
    error: uploadError,
    dismissError: dismissUploadError,
    busy: uploading,
  } = useMediaUpload(handleUploaded);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drag state is counted, not a boolean: dragging over a child element fires
  // dragleave on the parent, so a boolean flickers the highlight off mid-drag.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Uploading is a write, so it takes the same gate as posting — otherwise a
  // locked or read-only user could push bytes onto the volume without ever being
  // able to post them. See CLAUDE.md "transaction action requires sign-in".
  const startUpload = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      if (!requireIdentity()) return;
      void upload(files);
    },
    [requireIdentity, upload]
  );

  // Refocus textarea after post completes
  const wasPendingRef = useRef(false);
  useEffect(() => {
    if (wasPendingRef.current && !isPending) {
      // Hands-free on touch (see performSubmit) — don't re-pop the keyboard when a
      // post completes. Desktop refocuses for the next post.
      if (!window.matchMedia?.("(pointer: coarse)").matches) {
        textareaRef.current?.focus();
      }
    }
    wasPendingRef.current = isPending;
  }, [isPending]);

  const performSubmit = useCallback(
    (currentIdentity: NonNullable<typeof identity>, content: string): void => {
      if (!formRef.current) return;
      const formData = new FormData(formRef.current);
      formData.set("author", currentIdentity.name);
      formData.set("content", content);
      // Server-side this is looked up, never trusted — a parent that doesn't
      // exist is rejected rather than stored (see createPost).
      if (parentId !== undefined) formData.set("parent_id", String(parentId));

      const tempId = Date.now();
      onPostCreated?.(content, currentIdentity.name, tempId);
      formRef.current.reset();
      setHasContent(false);
      setDraft("");
      setJustPosted(true);
      setTimeout(() => setJustPosted(false), 1500);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        // Hands-free on touch: don't re-pop the keyboard after posting (you post
        // via the send button there, and reopening drags the header/bootboard
        // off-screen — #6). Desktop keeps the caret for continuous posting.
        // (mic fix 2026-06-26, mirrors handleTranscript + handleKeyDown)
        if (!window.matchMedia?.("(pointer: coarse)").matches) {
          textareaRef.current.focus();
        }
      }

      startTransition(async () => {
        const sig = await sign(content);
        if (sig) {
          formData.set("signature", sig.signature);
          formData.set("pubkey", sig.pubkey);
        }

        // ── Paid posting ───────────────────────────────────────────────────
        // ⚠ THE MODE IS ASKED FOR, NEVER ASSUMED. Guessing wrong in either
        // direction hurts the user: assume free and the server refuses a post
        // they wrote; assume paid and they spend money on a transaction the
        // server would have accepted for nothing.
        const mode = await getPostingMode();
        if (mode.paid) {
          const { postPrice, currentFeeRateSatsPerKb } = await import("@/lib/post-economics");
          const { clientSidePost } = await import("@/services/bsv/client-post");
          const { onchainRecord } = await import("@/lib/onchain-record");

          // The SAME envelope the server-funded path anchors, so a paid post and
          // a free one are the same record to anybody reading the chain.
          const payload = onchainRecord("post", {
            content,
            author: currentIdentity.name,
            sig: sig?.signature ?? null,
            pubkey: sig?.pubkey ?? null,
            parent: parentId ?? null,
          });

          // Price the WHOLE transaction, not the payload: the miner charges for
          // the transaction, and the envelope plus inputs and change dwarf the
          // text on a short post.
          const price = postPrice(payload.length + 600, {
            markupPercent: mode.markupPercent,
            // Same rate the transaction builder will use, so the quote and the
            // transaction cannot disagree.
            feeRateSatsPerKb: await currentFeeRateSatsPerKb(),
          });

          const paid = await clientSidePost(
            currentIdentity.wif,
            currentIdentity.address,
            payload,
            mode.platformAddress,
            price
          );

          if (paid.status !== "success") {
            // ⚠ NOTHING IS SENT TO THE SERVER ON FAILURE. A post the author did
            // not pay for must not be stored, and `createPost` would refuse it
            // anyway — reporting here keeps their draft recoverable instead of
            // showing a generic server rejection.
            onPostRejected?.(tempId, paid.status);
            return;
          }
          formData.set("raw_tx", paid.rawTx);
        }

        const result = await createPost(formData);
        if (!result.ok) {
          onPostRejected?.(tempId, result.reason);
        }
      });
    },
    [onPostCreated, onPostRejected, sign, parentId]
  );

  /**
   * Ask the platform agent, inline.
   *
   * ⚠ NO `requireIdentity()` GATE. Asking is a READ — it stores nothing, spends
   * nothing and signs nothing — and the sign-in prompt is reserved for actions
   * that need a key. Gating a question behind sign-in is exactly what the
   * deleted global click-catcher did wrong.
   */
  const askAgent = useCallback(async (question: string) => {
    setAgentError(null);
    setAgentStreaming(true);

    // The question joins the chain BEFORE the answer exists, so a record of
    // what was asked survives even if the model call fails.
    let working: AgentTurn[] = [];
    setChain((prev) => {
      working = [...prev, appendTurn(prev, "human", question)];
      return working;
    });

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The WHOLE exchange goes up, so a follow-up means what it says —
        // "what about that?" is unanswerable without the turns before it.
        body: JSON.stringify({
          messages: [
            ...working.map((t) => ({ from: t.role === "human" ? "user" : "agent", text: t.text })),
          ],
        }),
      });
      if (!res.ok || !res.body) {
        setAgentError("The agent is unavailable right now.");
        setAgentStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const prevHash = working[working.length - 1]?.hash ?? null;
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const text = acc;
        setChain([
          ...working,
          { role: "agent", text, prevHash, hash: hashTurn(prevHash, "agent", text) },
        ]);
      }

      const finalTurn: AgentTurn = {
        role: "agent",
        text: acc,
        prevHash,
        hash: hashTurn(prevHash, "agent", acc),
      };

      // ⚠ ATTESTED BY THE SERVER THAT RAN THE MODEL, not by us. Without this the
      // record only proves nothing changed after publication — it says nothing
      // about what the model actually returned. A failure here is NOT fatal: the
      // turn stays, marked unattested, because silently dropping the answer
      // would be worse than publishing an honestly-labelled claim.
      try {
        const att = await fetch("/api/agent/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prevHash, text: acc }),
        });
        if (att.ok) {
          const j = (await att.json()) as {
            attested?: boolean;
            signature?: string;
            pubkey?: string;
          };
          if (j.attested && j.signature && j.pubkey) {
            finalTurn.attestation = { signature: j.signature, pubkey: j.pubkey };
          }
        }
      } catch {
        /* unattested — rendered as such */
      }

      setChain([...working, finalTurn]);
    } catch {
      setAgentError("Couldn't reach the agent — try again.");
    } finally {
      setAgentStreaming(false);
    }
  }, []);

  function submitForm(): void {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    const content = formData.get("content");
    if (typeof content !== "string" || !content.trim()) return;
    const trimmed = content.trim();

    // ⚠ INTERCEPTED BEFORE EVERY POST GATE BELOW. A question is not a post: it
    // must not consume the permanence acknowledgement, must not trip the
    // sign-in prompt, and must never reach createPost.
    const command = parseSlashCommand(trimmed);
    if (command?.name === "agent") {
      if (!command.arg) {
        setAgentError("Ask a question after /agent — for example, /agent what is this board for?");
        return;
      }
      formRef.current.reset();
      setHasContent(false);
      setDraft("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      void askAgent(command.arg);
      return;
    }

    if (!requireIdentity() || !identity) {
      wantedToPostRef.current = true;
      return;
    }

    // One-time permanence acknowledgement before the user's first permanent
    // on-chain post (Phase 3 surfacing). After they confirm once, never again.
    const acked =
      typeof window !== "undefined" && localStorage.getItem("opencook_permanence_ack") === "1";
    if (!acked) {
      pendingPostRef.current = { identity, content: trimmed };
      setShowPermanenceGate(true);
      return;
    }

    performSubmit(identity, trimmed);
  }

  // After sign-in, focus the textarea + pulse the amber border (only if
  // there's still text to send). The amber border itself shows whenever
  // hasContent, so the pulse is a "your draft is still here" reminder, not
  // a state change. Only fires when a locked submit was attempted —
  // prevents focus-stealing for users who unlock pre-emptively.
  useEffect(() => {
    if (identity && wantedToPostRef.current) {
      wantedToPostRef.current = false;
      textareaRef.current?.focus();
      const hasText = (textareaRef.current?.value.trim() ?? "").length > 0;
      if (hasText) {
        setResumeNudge(true);
        const timer = setTimeout(() => setResumeNudge(false), 1600);
        return () => clearTimeout(timer);
      }
    }
  }, [identity]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // On touch devices the on-screen Return key should insert a newline, not post
    // (you post via the send button there). Desktop keeps Enter-to-post /
    // Shift+Enter-for-newline. (QA 2026-06-23)
    const isTouch =
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (isTouch) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitForm();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submitForm();
      }}
      className="w-full max-w-2xl"
    >
      {/* The agent's answer sits ABOVE the box it was asked from, so the
          question and the reply read in order and the composer stays put. */}
      <InlineAgentTranscript
        chain={chain}
        streaming={agentStreaming}
        error={agentError}
        onDismiss={() => {
          setChain([]);
          setAgentError(null);
        }}
        publishing={isPending}
        onPublish={() => {
          // Published through the ORDINARY post path: signed by the human, paid
          // for by the human, anchored like any other post. They asked, they
          // paid, they own the record — which is what keeps "own what you post"
          // true of an exchange with a machine.
          if (!requireIdentity() || !identity) return;
          const transcript = formatTranscript(chain);
          if (!transcript) return;
          setChain([]);
          setAgentError(null);
          performSubmit(identity, transcript);
        }}
      />
      {/* Drop target is the whole compose box, not just the textarea: aiming a
          drag at a one-line input is fiddly, and a drop that lands two pixels
          outside would otherwise navigate the tab to the file. `preventDefault`
          on dragOver is what stops that default navigation. */}
      {/* Drag-and-drop has no keyboard equivalent and needs none: the `+` button
          inside this div is the accessible, focusable path to the same action,
          and it is not conditional on pointer capability. Making the container
          itself focusable would add a tab stop that does nothing when reached. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div
        className="relative"
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types?.includes("Files")) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer?.types?.includes("Files")) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          startUpload(Array.from(e.dataTransfer.files));
        }}
      >
        <textarea
          ref={textareaRef}
          name="content"
          aria-label="Share an idea"
          onPaste={(e) => {
            // A screenshot on the clipboard is the commonest way an image
            // reaches a compose box; without this it pastes as nothing at all.
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return;
            e.preventDefault();
            startUpload(files);
          }}
          placeholder={
            !identity && !needsUnlock
              ? "Setting up your identity..."
              : (placeholder ?? "Share an idea...")
          }
          maxLength={1000}
          disabled={!identity && !needsUnlock}
          onKeyDown={handleKeyDown}
          className={`block w-full bg-zinc-900 border rounded-3xl pl-12 pr-14 py-3 sm:pl-13 sm:py-4 text-sm sm:text-base resize-none focus:outline-none placeholder:text-zinc-600 min-h-[48px] sm:min-h-[56px] max-h-[200px] disabled:opacity-50 scrollbar-hide ${
            resumeNudge ? "" : "transition-colors duration-300"
          } ${
            dragging
              ? "border-amber-400 focus:border-amber-400"
              : justPosted
                ? "border-green-600/60 focus:border-green-600/60"
                : resumeNudge && hasContent
                  ? "border-amber-400/60 focus:border-amber-400/60 animate-[nudgePulse_0.8s_ease-in-out_2]"
                  : hasContent
                    ? "border-amber-400/60 focus:border-amber-400/60"
                    : "border-zinc-800 focus:border-zinc-700"
          }`}
          style={{ scrollbarWidth: "none" }}
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            setHasContent(el.value.trim().length > 0);
            setDraft(el.value);
          }}
        />
        {/* Attach. Mirrors the mic/send button on the right — same size, same
            bottom offset — so the box stays symmetrical as it grows. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_MIME.join(",")}
          className="hidden"
          onChange={(e) => {
            startUpload(Array.from(e.target.files ?? []));
            // Cleared so choosing the SAME file twice in a row still fires
            // onChange the second time.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || (!identity && !needsUnlock)}
          aria-label="Add a photo, video or audio"
          title="Add a photo, video or audio"
          className={`absolute left-3 bottom-[7px] sm:bottom-[11px] rounded-full p-2.5 transition-colors disabled:opacity-40 ${
            dragging ? "text-amber-400" : "text-zinc-500 hover:text-amber-400"
          }`}
        >
          {uploading ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              className="animate-spin"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeOpacity="0.25"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          )}
        </button>
        {hasContent ? (
          <button
            type="button"
            onClick={submitForm}
            className="compose-send absolute right-3 bottom-[7px] sm:bottom-[11px] bg-amber-500 text-black rounded-full p-2.5 transition-colors hover:bg-amber-400"
            title="Post"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14m0 0l-6-6m6 6l-6 6" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleMic}
            disabled={voiceState === "transcribing"}
            className={`absolute right-3 bottom-[7px] sm:bottom-[11px] rounded-full p-2.5 transition-colors disabled:cursor-default ${
              voiceState === "recording"
                ? "bg-red-500 text-white ring-1 ring-inset ring-red-400/40 hover:bg-red-600 animate-pulse"
                : voiceState === "transcribing"
                  ? "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/25"
                  : "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/25 hover:text-amber-300"
            }`}
            title={
              voiceState === "recording"
                ? "Stop recording"
                : voiceState === "transcribing"
                  ? "Transcribing…"
                  : "Voice to text"
            }
          >
            {voiceState === "transcribing" ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="animate-spin"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeOpacity="0.25"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
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
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            )}
          </button>
        )}
      </div>
      {/* ⚠ A "/" IS AMBIGUOUS UNTIL IT IS FINISHED, so say what it does before
          the send button is pressed — the same job TickerHint does for "$".
          Without this, a slash command is a feature only the person who built
          it knows exists, and the first thing a user learns is that their post
          vanished. */}
      {draft.trimStart().startsWith("/") && (
        <p className="mt-1.5 px-1 text-[11px] text-zinc-500">
          {parseSlashCommand(draft) ? (
            <>
              <span className="text-amber-400">/agent</span> asks the AI &mdash; this won&rsquo;t be
              posted
            </>
          ) : (
            <>
              Starts with &ldquo;/&rdquo; but isn&rsquo;t a command, so it posts as written. Try{" "}
              <span className="text-amber-400">/agent</span>
            </>
          )}
        </p>
      )}
      {/* Claim-vs-cite disclosure for any $Ticker being typed. See TickerHint. */}
      <TickerHint content={draft} />
      {uploading && (
        <p className="mt-1 text-[11px] text-zinc-500" aria-live="polite">
          {uploadTotal > 1
            ? `Uploading ${uploadTotal - uploadPending + 1} of ${uploadTotal}…`
            : "Uploading…"}
        </p>
      )}
      {uploadError && !uploading && (
        <button
          type="button"
          onClick={dismissUploadError}
          className="mt-1 w-full text-left text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 hover:bg-amber-500/15 transition-colors"
          aria-live="polite"
        >
          {uploadError}
        </button>
      )}
      {voiceError && (
        <button
          type="button"
          onClick={dismissMicError}
          className="mt-1 w-full text-left text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 hover:bg-amber-500/15 transition-colors"
          aria-live="polite"
        >
          {voiceError}
        </button>
      )}
      {/* Three-column grid — helper text left (desktop only), install bookmark
          center, Ask AI right. Bookmark is centered relative to the textarea
          above. When the bookmark is not rendered (most of the time — only
          visible after the user has saved + protected + minimised the sheet),
          the center cell collapses gracefully. Mobile (helper text hidden)
          uses a sm:hidden spacer to hold the left cell's shape. */}
      {!compact && (
        <div className="grid grid-cols-3 items-center mt-1 ml-1 mr-1 max-h-12 overflow-visible opacity-100 transition-all duration-200 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:mt-0 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:max-h-0 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:opacity-0 pointer-coarse:group-has-[textarea:focus,.compose-send:focus]:overflow-hidden">
          <div className="hidden sm:flex items-center gap-2">
            <p className="text-[11px] text-zinc-600">Enter to post, Shift+Enter for new line</p>
            <span
              className={`text-[11px] text-green-500 transition-opacity duration-300 ${justPosted ? "opacity-100" : "opacity-0"}`}
              aria-live="polite"
            >
              Posted
            </span>
          </div>
          <div className="sm:hidden" />
          <div className="flex justify-center relative z-10">
            <InstallBookmark />
          </div>
          <div className="flex justify-end">
            <AgentChat highlight={agentHighlight} />
          </div>
        </div>
      )}
      {showPermanenceGate && (
        <PermanenceGate
          onConfirm={() => {
            try {
              localStorage.setItem("opencook_permanence_ack", "1");
            } catch {
              /* localStorage unavailable — gate re-appears next attempt, acceptable */
            }
            const pending = pendingPostRef.current;
            pendingPostRef.current = null;
            setShowPermanenceGate(false);
            if (pending) performSubmit(pending.identity, pending.content);
          }}
          onCancel={() => {
            pendingPostRef.current = null;
            setShowPermanenceGate(false);
          }}
        />
      )}
    </form>
  );
}
