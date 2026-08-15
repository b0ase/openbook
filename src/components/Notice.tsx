"use client";

import { useEffect, useState } from "react";

/**
 * A transient, neutral message about the action just taken.
 *
 * ⚠ THE POINT IS THAT SOMETHING ANSWERS. A control that crosses the network can
 * fail for reasons invisible from the page — a name nobody claimed, a tab held
 * open across a deploy — and in every one of those cases the reader's experience
 * is identical: they tapped, and nothing happened. That is indistinguishable
 * from a broken site, so the fix is to say which it was.
 *
 * Deliberately NOT `BootToast`: that one is red and tappable-to-retry, because a
 * boot failure means money did not move. Most of what lands here is ordinary
 * information, and dressing it as an error would teach readers to ignore the red
 * one that matters.
 */
export function Notice({ message }: { message: string | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }
    // One frame late so the transition has a state to move from.
    const t = setTimeout(() => setVisible(true), 16);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 px-4 transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <p className="max-w-[90vw] rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-center text-sm text-zinc-300 shadow-lg">
        {message}
      </p>
    </div>
  );
}
