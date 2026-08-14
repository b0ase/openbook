"use client";

/**
 * The platform agent's answer, shown in place above the compose box.
 *
 * ⚠ EPHEMERAL BY DESIGN — THIS IS NOT A POST. It is never stored, never
 * anchored, and mints no token. That is deliberate rather than unfinished:
 * a posted answer would be permanent and on-chain, which means an agent
 * hallucination could not be unwritten, and it would immediately raise a
 * question the token model has not answered — who OWNS a token the agent
 * produced? Under *revenue follows ownership* that is not cosmetic.
 *
 * The route the model already has: the reader can copy an answer into their own
 * post, which makes THEM the author and owner. "Own what you post" stays true
 * because a person posted it.
 */
export function InlineAgentAnswer({
  question,
  answer,
  streaming,
  error,
  onDismiss,
}: {
  question: string;
  answer: string;
  streaming: boolean;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-2 rounded-xl border border-amber-400/20 bg-[#0f0f0f] px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-[11px] text-zinc-500">
          <span className="text-amber-400">Ask AI</span>
          {question && <span className="text-zinc-600"> · {question}</span>}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss answer"
          className="-m-2 shrink-0 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ✕
        </button>
      </div>

      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-200">
        {error ? (
          <span className="text-amber-400">{error}</span>
        ) : answer ? (
          answer
        ) : (
          <span className="text-zinc-600">Thinking…</span>
        )}
        {streaming && answer && <span className="ml-0.5 animate-pulse text-amber-400">▍</span>}
      </p>

      {/* Said plainly, because the whole board is built on the opposite
          promise. Everything else typed here is permanent; this is not. */}
      {!streaming && (answer || error) && (
        <p className="mt-1.5 text-[10px] text-zinc-600">
          Not posted &mdash; only you can see this. Copy it into a post to keep it.
        </p>
      )}
    </div>
  );
}
