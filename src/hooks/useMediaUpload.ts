"use client";

import { useCallback, useRef, useState } from "react";
import { checkUpload, formatBytes } from "@/lib/upload";

/**
 * Uploading media from the compose box.
 *
 * The same `checkUpload` the API route uses runs here first, so a file that will
 * be refused is refused instantly and with a specific reason, rather than after
 * a 60MB round-trip that ends in a generic failure. The server still checks —
 * this is a courtesy, not a control.
 *
 * Files upload ONE AT A TIME, deliberately. Dropping a folder of images would
 * otherwise open a dozen parallel connections, and on a phone that is the fast
 * path to a stalled radio and a batch that half-fails. Sequential also makes the
 * progress count honest: "2 of 5" means something.
 */

export interface MediaUploadState {
  /** How many files are still to go, including the one in flight. */
  pending: number;
  /** Total in the current batch, for "n of m". */
  total: number;
  error: string | null;
}

export function useMediaUpload(onUploaded: (url: string) => void) {
  const [state, setState] = useState<MediaUploadState>({ pending: 0, total: 0, error: null });
  // A second drop while the first batch is in flight would otherwise reset the
  // counters and lose the tail of the first batch.
  const busyRef = useRef(false);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length || busyRef.current) return;

      const accepted: File[] = [];
      let rejection: string | null = null;
      for (const file of files) {
        const check = checkUpload(file.type, file.size);
        if (check.ok) {
          accepted.push(file);
        } else if (!rejection) {
          // Report the FIRST problem only. A drop of ten unsupported files
          // should say what is wrong once, not ten times.
          rejection =
            check.reason === "too_large"
              ? `${file.name || "That file"} is too big — the limit is ${formatBytes(check.limitBytes ?? 0)}.`
              : check.reason === "empty"
                ? `${file.name || "That file"} is empty.`
                : "Images, video and audio only.";
        }
      }

      if (!accepted.length) {
        setState({ pending: 0, total: 0, error: rejection ?? "Nothing to upload." });
        return;
      }

      busyRef.current = true;
      setState({ pending: accepted.length, total: accepted.length, error: rejection });

      let failure: string | null = null;
      for (const file of accepted) {
        try {
          const body = new FormData();
          body.set("file", file);
          const res = await fetch("/api/upload", { method: "POST", body });
          const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
          if (!res.ok || !data.url) {
            failure = data.error ?? "Upload failed — try again.";
            break;
          }
          // Inserted as each one lands, not all at the end: a slow batch still
          // shows progress in the box the user is looking at.
          onUploaded(data.url);
        } catch {
          failure = "Upload failed — check your connection.";
          break;
        } finally {
          setState((s) => ({ ...s, pending: Math.max(0, s.pending - 1) }));
        }
      }

      busyRef.current = false;
      setState((s) => ({ pending: 0, total: 0, error: failure ?? s.error }));
    },
    [onUploaded]
  );

  return { ...state, upload, dismissError, busy: state.pending > 0 };
}
