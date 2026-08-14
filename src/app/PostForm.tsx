"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { InstallBookmark } from "@/components/InstallBookmark";
import { PermanenceGate } from "@/components/PermanenceGate";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useVoiceToText } from "@/hooks/useVoiceToText";
import { AgentChat } from "./AgentChat";
import { createPost } from "./actions";

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
  const [justPosted, setJustPosted] = useState(false);
  const [resumeNudge, setResumeNudge] = useState(false);
  const { identity, needsUnlock, sign, requireIdentity } = useIdentityContext();
  // Set when the user tries to submit while locked — drives a focus + amber
  // border pulse once identity arrives, so the user knows their draft is
  // waiting and can hit Enter to send.
  const wantedToPostRef = useRef(false);
  // One-time permanence acknowledgement gate, shown before the user's FIRST post.
  const [showPermanenceGate, setShowPermanenceGate] = useState(false);
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
        const result = await createPost(formData);
        if (!result.ok) {
          onPostRejected?.(tempId, result.reason);
        }
      });
    },
    [onPostCreated, onPostRejected, sign, parentId]
  );

  function submitForm(): void {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    const content = formData.get("content");
    if (typeof content !== "string" || !content.trim()) return;
    const trimmed = content.trim();

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
      <div className="relative">
        <textarea
          ref={textareaRef}
          name="content"
          aria-label="Share an idea"
          placeholder={
            !identity && !needsUnlock
              ? "Setting up your identity..."
              : (placeholder ?? "Share an idea...")
          }
          maxLength={1000}
          disabled={!identity && !needsUnlock}
          onKeyDown={handleKeyDown}
          className={`block w-full bg-zinc-900 border rounded-3xl pl-4 pr-14 py-3 sm:pl-5 sm:py-4 text-sm sm:text-base resize-none focus:outline-none placeholder:text-zinc-600 min-h-[48px] sm:min-h-[56px] max-h-[200px] disabled:opacity-50 scrollbar-hide ${
            resumeNudge ? "" : "transition-colors duration-300"
          } ${
            justPosted
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
          }}
        />
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
