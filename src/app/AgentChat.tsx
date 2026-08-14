"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Message {
  from: "user" | "agent";
  text: string;
}

const SUGGESTED = [
  "What is this?",
  "How does boosting work?",
  "What's the fairness agent?",
  "How do I post?",
];

export function AgentChat({ highlight }: { highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);

  const [userScrolled, setUserScrolled] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        {
          from: "agent",
          text: "Hey! I can help you understand OpenBooks, brainstorm ideas for posts, or answer any questions. What are you curious about?",
        },
      ]);
    }
  }, [open, messages.length]);

  // Follow the AI response as it streams. messages in deps so each token
  // chunk triggers a scroll. behavior: instant (not smooth) avoids iOS
  // queueing competing scroll animations during fast streaming. userScrolled
  // freezes auto-scroll once the user manually scrolls up — letting them
  // re-read earlier content without being yanked back to bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the intentional re-fire trigger; body doesn't read it but effect must run on every messages change.
  useEffect(() => {
    if (!userScrolled) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, userScrolled]);

  // Reset scroll tracking when user sends a new message
  function handleUserScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolled(!atBottom);
  }

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Clean up any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const ask = useCallback(async function ask(question: string) {
    const userMsg: Message = { from: "user", text: question };
    const thinking: Message = { from: "agent", text: "..." };
    const newMessages = [...messagesRef.current, userMsg];
    setMessages([...newMessages, thinking]);
    setInput("");
    setIsStreaming(true);
    setUserScrolled(false); // auto-scroll to user's own message

    // Abort any previous stream
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.filter((m) => m.text !== "..."),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        setMessages([
          ...newMessages,
          { from: "agent", text: errorText || "Agent had a hiccup — try again in a moment." },
        ]);
        setIsStreaming(false);
        return;
      }

      if (!res.body) {
        setMessages([
          ...newMessages,
          { from: "agent", text: "Couldn't reach the agent right now." },
        ]);
        setIsStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        // Update the last message with accumulated text
        const text = accumulated;
        setMessages([...newMessages, { from: "agent", text }]);
      }

      // Final update (ensure last chunk is flushed)
      if (accumulated) {
        setMessages([...newMessages, { from: "agent", text: accumulated }]);
      } else {
        setMessages([...newMessages, { from: "agent", text: "I'm not sure how to answer that." }]);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error("Agent stream error:", e);
      setMessages([...newMessages, { from: "agent", text: "Couldn't reach the agent right now." }]);
    } finally {
      setIsStreaming(false);
    }
  }, []);

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    ask(input.trim());
    // Dismiss the iOS keyboard after sending — chat UX wants the user
    // reading the streaming reply, not staring at a focused input.
    inputRef.current?.blur();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`group flex items-center gap-1.5 text-xs border rounded-full px-2.5 py-2 transition-all mt-1 ${
          highlight
            ? "text-amber-300 border-amber-500 bg-amber-500/10 scale-110 shadow-[0_0_12px_rgba(245,158,11,0.3)]"
            : "text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-300 hover:bg-zinc-900"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${highlight ? "bg-amber-400 animate-ping" : "bg-cyan-400/70 animate-pulse"}`}
        />
        Ask AI
        {/* Decorative GitHub tease — devs notice, casuals don't. The actual
            link lives in the modal footer; this is a hint, not a CTA.
            Shown in BOTH normal and highlight states — the manifesto's
            "Chat with the agent" CTA puts the pill into highlight, and
            that's exactly when the open-source signal is most contextually
            relevant (the user just read the Vision pitch). */}
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
          className={`transition-colors ${
            highlight ? "text-amber-200/70" : "text-zinc-300 group-hover:text-zinc-100"
          }`}
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </button>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        className="fixed inset-0 z-50 w-full bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out] cursor-default"
        aria-label="Close dialog"
        onClick={() => setOpen(false)}
      />

      {/* Modal — bottom-sheet on mobile, centered on desktop. The card is
          flex-col with max-h capped so the messages list compresses when the
          iOS keyboard opens, keeping the input row visible above the keyboard.
          Without this, h-[60vh] on messages stayed fixed, squeezing the input
          off-screen when the layout viewport shrank. */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-2 pb-2 sm:p-4 pointer-events-none">
        <div
          className="w-full sm:max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] shadow-2xl flex flex-col max-h-[calc(100svh-env(safe-area-inset-top)-0.5rem)] sm:max-h-[calc(100dvh-2rem)]"
          role="dialog"
          aria-modal="true"
          aria-label="OpenBooks Agent"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* Header — pt-3 for normal breathing room. The wrapper's
              pt-[max(0.5rem,env(safe-area-inset-top))] already pushes
              the card's top edge below the status bar, so the header
              does NOT need its own env(safe-area-inset-top) padding —
              that was triple-dipping with the wrapper pt and the
              card's max-h reduction, making the modal extend too high
              on Safari after body overflow:hidden was restored. */}
          <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-sm font-medium text-zinc-300">OpenBooks Agent</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="text-zinc-600 hover:text-zinc-300 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8m0-8l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Messages — flex-1 min-h-0 so it compresses when keyboard
              shrinks the layout viewport (interactive-widget=resizes-content),
              keeping the input row visible. min-h-0 is critical: without it
              the flex child refuses to shrink below content height. */}
          <div
            ref={messagesContainerRef}
            onScroll={handleUserScroll}
            className="flex-1 min-h-0 sm:h-[450px] sm:flex-none overflow-y-auto overscroll-y-contain scrollbar-hide px-4 py-3 space-y-3"
            style={{ scrollbarWidth: "none" }}
          >
            {messages.map((msg) => (
              <div
                key={`${msg.from}-${msg.text.slice(0, 32)}`}
                className={`flex flex-col ${msg.from === "user" ? "items-end" : "items-start"}`}
              >
                <span className="text-[10px] text-zinc-600 mb-0.5 px-1">
                  {msg.from === "agent" ? "agent" : "you"}
                </span>
                <div
                  className={`rounded-xl px-3 py-2 text-sm leading-relaxed max-w-[85%] ${
                    msg.from === "agent"
                      ? "bg-zinc-900 text-zinc-300"
                      : "bg-amber-500/10 border border-amber-500/20 text-amber-200"
                  } ${msg.text === "..." ? "animate-pulse" : ""}`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Suggested questions */}
          {messages.length <= 1 && (
            <div className="shrink-0 px-4 pb-3 flex flex-wrap gap-1.5">
              {SUGGESTED.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  disabled={isStreaming}
                  className="text-xs text-zinc-500 border border-zinc-800 rounded-full px-3 py-1.5 hover:border-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input — flex row so the send button sits inline at the right.
              Button is amber-tinted and disabled when there's no text or a
              stream is in flight. enterKeyHint=send also relabels the iOS
              Return key as "Send" for users who don't notice the button. */}
          <div className="shrink-0 border-t border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSubmit(e);
                  }
                }}
                placeholder={isStreaming ? "Thinking..." : "Ask something..."}
                disabled={isStreaming}
                enterKeyHint="send"
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
                className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!input.trim() || isStreaming}
                aria-label="Send"
                className="shrink-0 text-amber-400 hover:text-amber-300 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors p-1.5"
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
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>

          {/* Open-source footer — quiet trust signal for users investigating
              the project. The pill's GitHub tease (decorative) brings them
              here; this is the actual repo link. Center-aligned with a
              half-opacity divider so it reads as a footer tier subordinate
              to the input row above. Safe-area padding so the link doesn't
              sit on the iOS home indicator on bottom-sheet display. */}
          <div className="shrink-0 border-t border-zinc-800/50 px-4 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pb-3.5 flex flex-col items-center gap-1.5">
            <a
              href="https://github.com/b0ase/openbook"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs text-zinc-300 hover:text-zinc-100 transition-colors"
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              The code is open.
              <span className="text-zinc-600">↗</span>
            </a>
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <a href="/terms" className="transition-colors hover:text-zinc-300">
                Terms
              </a>
              <span className="text-zinc-700">·</span>
              <a href="/privacy" className="transition-colors hover:text-zinc-300">
                Privacy
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
