"use client";

import { type AgentTurn, stampTurn } from "@/lib/agent-record";

/**
 * The running human/AI exchange, printed above the compose box.
 *
 * ⚠ IT IS A CONVERSATION, NOT A FEED. Both are rendered from the same screen,
 * and the feed means one specific thing on this board — permanent, owned,
 * on-chain. So this is deliberately unlike a post: no author chip, no boost
 * button, and an explicit line saying what it is. Somebody reading quickly must
 * not mistake an exchange for something already published.
 *
 * ⚠ THE TIME IS SHOWN AS AN ABSOLUTE UTC STAMP, never the feed's relative "just
 * now". It is part of the hashed record rather than decoration — it is what the
 * server dated the answer, and on an agent turn the attestation signs it — so it
 * is rendered in monospace beside the hash, where it reads as evidence and not
 * as another post's byline.
 *
 * ⚠ EACH TURN SHOWS WHETHER IT IS ATTESTED. The hash chain proves nothing was
 * altered after the fact; only the server's signature speaks to what the model
 * actually returned. An unattested agent turn is what the poster SAYS the agent
 * replied, and this must never render it as verified — that is the difference
 * between a record and a decoration.
 */
export function InlineAgentTranscript({
  chain,
  streaming,
  error,
  onDismiss,
  onPublish,
  publishing,
}: {
  chain: AgentTurn[];
  streaming: boolean;
  error: string | null;
  onDismiss: () => void;
  onPublish?: () => void;
  publishing?: boolean;
}) {
  if (!chain.length && !error) return null;

  return (
    <div className="mb-2 rounded-xl border border-amber-400/20 bg-[#0f0f0f] px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] text-amber-400">Ask AI</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-2 shrink-0 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="mt-1 max-h-64 space-y-2 overflow-y-auto">
        {/* ⚠ KEYED ON `prevHash`, not on `hash` and not on the index. A turn is
            re-hashed on every streamed chunk, so keying on its OWN hash would
            remount the node mid-answer and drop the reader's scroll position.
            `prevHash` identifies the same turn throughout — the chain is
            append-only so no two turns share one — and unlike an index it does
            not silently reuse state if the list ever changes shape. */}
        {chain.map((turn) => (
          <div key={turn.prevHash ?? "root"}>
            <div className="flex items-baseline gap-2">
              <span
                className={`shrink-0 text-[10px] font-medium ${
                  turn.role === "human" ? "text-zinc-400" : "text-amber-400"
                }`}
              >
                {turn.role === "human" ? "You" : "AI"}
              </span>
              <span
                title={stampTurn(turn.ts)}
                className="shrink-0 font-mono text-[9px] text-zinc-600"
              >
                {stampTurn(turn.ts).slice(11)}
              </span>
              {turn.role === "agent" && (
                <span
                  title={
                    turn.attestation
                      ? "Signed by the server that ran the model"
                      : "Not signed — this is what was shown, but the server did not attest it"
                  }
                  className={`shrink-0 font-mono text-[9px] ${
                    turn.attestation ? "text-emerald-500" : "text-zinc-600"
                  }`}
                >
                  {turn.attestation ? "attested" : "unattested"} · {turn.hash.slice(0, 8)}
                </span>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-200">
              {turn.text}
              {streaming && turn === chain[chain.length - 1] && turn.role === "agent" && (
                <span className="ml-0.5 animate-pulse text-amber-400">▍</span>
              )}
            </p>
          </div>
        ))}
        {streaming && chain[chain.length - 1]?.role === "human" && (
          <p className="text-[13px] text-zinc-600">Thinking…</p>
        )}
      </div>

      {error && <p className="mt-1.5 text-[12px] text-amber-400">{error}</p>}

      {!streaming && chain.length > 0 && (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-zinc-800/60 pt-2">
          {/* Said plainly: everything else typed into this box is permanent, and
              this is not — until the human chooses to publish it. */}
          <span className="text-[10px] leading-relaxed text-zinc-600">
            Not posted yet &mdash; ask again to continue.
          </span>
          {onPublish && (
            <button
              type="button"
              onClick={onPublish}
              disabled={publishing}
              className="shrink-0 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
            >
              {publishing ? "Posting…" : "Post this exchange"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
