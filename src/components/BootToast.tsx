"use client";

import { useEffect, useState } from "react";

interface BootToastProps {
  message: string | null;
  onRetry?: () => void;
}

/**
 * Fixed-bottom toast for boot failures.
 * Slides up on mount, auto-dismisses after 5s.
 * Tap anywhere on the toast to retry.
 */
export function BootToast({ message, onRetry }: BootToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      // Tiny delay so the CSS transition fires
      const t = setTimeout(() => setVisible(true), 16);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [message]);

  if (!message) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-2 rounded-full border border-red-500/40 bg-zinc-900 px-4 py-2 text-sm text-red-400 shadow-lg hover:bg-zinc-800 transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 5v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
        {message}
      </button>
    </div>
  );
}
