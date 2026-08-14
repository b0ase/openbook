/**
 * Pure file-format parser for OpenBooks recovery files. No side effects (no DOM,
 * no storage, no network). Returns a typed payload that callers (`RestoreModal`,
 * `HomeScreenWelcomeGate`) hand off to `decryptWif` and `importEncryptedIdentity`.
 *
 * Restore policy: only files produced by the current system are accepted. Every
 * file we generate carries `fileVersion === RECOVERY_FILE_VERSION` (stamped in
 * backup-template.ts). Legacy files — plaintext WIF, or older encrypted files
 * without the version stamp — are rejected with `unsupported_version`. Old files
 * provably cannot fake the stamp (the field did not exist when they were made).
 *
 * Supports the same file containers as before (only the acceptance rule changed):
 * - HTML files with the marker block (`@BACKUP_DATA_START ... @BACKUP_DATA_END`)
 * - HTML files with legacy `const BACKUP_DATA = {...}` syntax
 * - Pure JSON files (`{ "wif_encrypted": "..." }`)
 *
 * The parsing regex is identical to `RestoreModal`'s former inline parser —
 * extracted so the welcome-gate restore path can use it without depending on
 * RestoreModal, which requires a `currentIdentity` that doesn't exist at
 * welcome-gate time.
 */

import { RECOVERY_FILE_VERSION } from "./backup-template";

export type RecoveryFilePayload =
  | { kind: "plain"; wif: string; name?: string }
  | { kind: "encrypted"; wif_encrypted: string; name?: string; hint?: string };

export type ParseRecoveryFileResult =
  | { ok: true; payload: RecoveryFilePayload }
  | { ok: false; error: "parse_failed" | "no_key" | "unsupported_version" };

/** Internal — synchronous parse of the file's text content. Exported for tests. */
export function parseRecoveryText(text: string): ParseRecoveryFileResult {
  const trimmed = text.trimStart();
  let parsed: {
    wif?: string;
    wif_encrypted?: string;
    name?: string;
    hint?: string;
    fileVersion?: number;
  } | null = null;

  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    text.includes("BACKUP_DATA")
  ) {
    const markerMatch = text.match(
      /@BACKUP_DATA_START[\s\S]*?const BACKUP_DATA\s*=\s*(\{[\s\S]*?\});\s*\/\/\s*@BACKUP_DATA_END/
    );
    if (markerMatch) {
      try {
        parsed = JSON.parse(markerMatch[1]);
      } catch {
        /* fall through to legacy attempt */
      }
    }
    if (!parsed) {
      const legacyMatch = text.match(/const BACKUP_DATA\s*=\s*(\{[\s\S]*?\});/);
      if (legacyMatch) {
        try {
          parsed = JSON.parse(legacyMatch[1]);
        } catch {
          /* fall through to parse_failed below */
        }
      }
    }
    if (!parsed) return { ok: false, error: "parse_failed" };
  } else if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: "parse_failed" };
    }
  } else {
    return { ok: false, error: "parse_failed" };
  }

  // Restore policy gate. Reject legacy files BEFORE branching on key shape:
  // - plaintext (a bare `wif` with no `wif_encrypted`) is no longer supported;
  // - any file missing the current `fileVersion` stamp (all pre-version files)
  //   is rejected. New files always carry the stamp (backup-template.ts).
  if (parsed?.wif && !parsed?.wif_encrypted) {
    return { ok: false, error: "unsupported_version" };
  }
  if (parsed?.fileVersion !== RECOVERY_FILE_VERSION) {
    return { ok: false, error: "unsupported_version" };
  }

  if (parsed?.wif_encrypted) {
    return {
      ok: true,
      payload: {
        kind: "encrypted",
        wif_encrypted: parsed.wif_encrypted,
        name: parsed.name,
        hint: parsed.hint,
      },
    };
  }
  return { ok: false, error: "no_key" };
}

/**
 * Read a File via FileReader, then run `parseRecoveryText` on the result.
 * Resolves with a typed `ParseRecoveryFileResult` — never throws on bad input.
 */
export async function parseRecoveryFile(file: File): Promise<ParseRecoveryFileResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      resolve(parseRecoveryText(text));
    };
    reader.onerror = () => resolve({ ok: false, error: "parse_failed" });
    reader.readAsText(file);
  });
}
