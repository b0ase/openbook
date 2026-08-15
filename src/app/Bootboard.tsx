"use client";

import { useEffect, useRef, useState } from "react";
import { BootIcon } from "@/components/icons/BootIcon";
import { useBootContext } from "@/contexts/BootContext";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useBoot } from "@/hooks/useBoot";
import { titleCaseTicker } from "@/lib/ticker";
import type { BootboardData } from "@/types";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function LiveTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(`${since}Z`).getTime();
    function tick() {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);

  return <span className="font-mono text-amber-400 text-xs">{formatDuration(elapsed)}</span>;
}

function HistoryRow({
  entry,
  onBooted,
  onFundNeeded,
}: {
  entry: BootboardData["history"][0];
  onBooted?: () => void;
  onFundNeeded?: (address: string, balance?: number, fee?: number) => void;
}) {
  const { identity, requireIdentity } = useIdentityContext();
  const { bootingPostId, throttled } = useBootContext();
  const { boot } = useBoot({ onBooted, onFundNeeded });

  const isThisBooting = bootingPostId === entry.post_id;
  const anyBooting = bootingPostId !== null;
  const isBlocked = anyBooting || throttled;

  function handleReboot() {
    if (isBlocked) return;
    // Opens SignInModal if locked; caller retaps after signing in.
    if (!requireIdentity() || !identity) return;
    boot(entry.post_id, identity);
  }

  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-600 py-0.5">
      <button
        type="button"
        onClick={handleReboot}
        disabled={isBlocked}
        className={`relative -m-2 p-2 shrink-0 flex items-center rounded-full transition-all disabled:cursor-not-allowed border ${
          isThisBooting
            ? "text-amber-400 border-amber-500/40"
            : isBlocked
              ? "opacity-50 text-zinc-600 border-zinc-800"
              : "text-zinc-600 border-zinc-800 hover:border-zinc-700 hover:text-amber-400 hover:bg-zinc-800/50 disabled:opacity-30"
        }`}
        title="Reboot this post"
      >
        {isThisBooting ? (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="animate-spin text-amber-400"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeOpacity="0.25"
            />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <BootIcon size={11} />
        )}
      </button>
      <span className="text-zinc-500 shrink-0">
        {displayIdentity(entry.boosted_by_nym, entry.author_name, entry.boosted_by)}
      </span>
      <span className="shrink-0">·</span>
      <span className="shrink-0">{formatDuration(entry.duration_seconds)}</span>
      <span className="shrink-0">·</span>
      <span className="truncate">{entry.content}</span>
    </div>
  );
}

/** A claimed $Nym outranks the generated handle wherever an identity is shown. */
function displayIdentity(nym: string | null | undefined, fallback: string | null, address: string) {
  if (nym) return `$${titleCaseTicker(nym)}`;
  return fallback ?? address;
}

export function Bootboard({
  data,
  onBooted,
  bootPrice,
  onFundNeeded,
}: {
  data: BootboardData;
  onBooted?: () => void;
  bootPrice?: number;
  onFundNeeded?: (address: string, balance?: number, fee?: number) => void;
}) {
  const { current, history } = data;
  const [shaking, setShaking] = useState(false);
  const [glowing, setGlowing] = useState(false);
  const [slideIn, setSlideIn] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const prevIdRef = useRef<number | null>(null);

  useEffect(() => {
    const currentId = current?.id ?? null;
    if (prevIdRef.current !== null && currentId !== null && currentId !== prevIdRef.current) {
      setShaking(true);
      setGlowing(true);
      setSlideIn(true);

      const shakeTimer = setTimeout(() => setShaking(false), 600);
      const glowTimer = setTimeout(() => setGlowing(false), 1200);
      const slideTimer = setTimeout(() => setSlideIn(false), 400);

      prevIdRef.current = currentId;
      return () => {
        clearTimeout(shakeTimer);
        clearTimeout(glowTimer);
        clearTimeout(slideTimer);
      };
    }
    prevIdRef.current = currentId;
  }, [current?.id]);

  return (
    <div
      className={`relative rounded-xl border bg-gradient-to-b from-amber-500/8 to-amber-500/3 px-3.5 py-3.5 transition-all duration-300 ${
        glowing ? "border-amber-400 shadow-[0_0_20px_rgba(245,158,11,0.3)]" : "border-amber-500/30"
      } ${shaking ? "animate-[shake_0.5s_ease-in-out]" : ""}`}
    >
      {current ? (
        <div className={slideIn ? "animate-[slideUp_0.4s_ease-out_backwards]" : ""}>
          {/* Meta line — label + author + timer */}
          <div className="flex flex-wrap items-center justify-between text-xs text-zinc-500 mb-1.5 gap-y-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <BootIcon size={14} className="text-amber-400 shrink-0" />
              {/* "Boost Board", not "Bootboard". "Boot" is inherited OpenCook
                  vocabulary for what is plainly a boost, and reusing the old word
                  under a new product invites people to assume the old mechanics
                  came with it. The identifiers, table and API route still say
                  `boot` — renaming those is a migration with real risk and no
                  user-visible benefit. */}
              <span className="text-amber-400 font-semibold text-[11px] uppercase tracking-wide shrink-0">
                Boost Board
              </span>
              <span className="text-zinc-700 shrink-0">·</span>
              <span className="font-medium text-amber-300 truncate">{current.author_name}</span>
              {current.signature && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block shrink-0"
                  title="Signed"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              <LiveTimer since={current.booted_at} />
            </div>
          </div>

          {/* Content */}
          <p className="text-sm leading-snug text-zinc-100 whitespace-pre-wrap break-words">
            {current.content}
          </p>

          {/* Expanded: scrollable history with reboot */}
          {expanded && (
            <div className="animate-[slideUp_0.2s_ease-out_backwards] mt-2 pt-2 border-t border-zinc-800/40">
              <div className="flex items-center gap-2 text-[11px] text-zinc-600 mb-1.5">
                <span>
                  boosted by{" "}
                  {displayIdentity(
                    current.boosted_by_nym,
                    current.boosted_by_name,
                    current.boosted_by
                  )}
                </span>
              </div>
              {history.length > 0 && (
                <div
                  className="max-h-[120px] overflow-y-auto scrollbar-hide space-y-1"
                  style={{ scrollbarWidth: "none" }}
                >
                  {history.map((h) => (
                    <HistoryRow
                      key={`${h.post_id}-${h.booted_at}`}
                      entry={h}
                      onBooted={onBooted}
                      onFundNeeded={onFundNeeded}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <BootIcon size={14} className="text-amber-400" />
          <span className="text-amber-400 font-semibold text-[11px] uppercase tracking-wide">
            Boost Board
          </span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-600">Boost any post to claim the spotlight</span>
          {bootPrice !== undefined && bootPrice > 0 && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-600">{bootPrice.toLocaleString()} sats</span>
            </>
          )}
        </div>
      )}

      {/* Expand/collapse — small chevron at the absolute bottom-center of
          the card, sitting inside the existing 14px bottom padding zone.
          Zero feed-room loss, zero card enlargement. Rotates 180° when
          expanded to indicate "tap to collapse". */}
      {current && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Collapse history" : "Expand history"}
          className="absolute bottom-0 left-1/2 -translate-x-1/2 px-3 py-1 text-zinc-500 hover:text-amber-300 transition-colors"
        >
          <svg
            width="14"
            height="8"
            viewBox="0 0 14 8"
            fill="none"
            aria-hidden="true"
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path
              d="M2 2l5 4 5-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
