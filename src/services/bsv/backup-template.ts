/**
 * backup-template.ts
 * Generates a self-contained HTML recovery file for OpenBooks identities.
 * The generated file works entirely offline — no network calls, no external scripts.
 */

// The OpenBooks icon SVG, embedded as a base64 favicon.
// Source: public/icon.svg
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
  '<rect width="512" height="512" rx="112" fill="#fbbf24"/>' +
  '<circle cx="256" cy="256" r="196" fill="#000000"/>' +
  '<text x="256" y="256" font-family="ui-monospace,\'SF Mono\',\'Cascadia Code\',monospace"' +
  ' font-weight="800" font-size="228" text-anchor="middle"' +
  ' dominant-baseline="central" letter-spacing="-12">' +
  '<tspan fill="#fbbf24">O</tspan><tspan fill="#ffffff">C</tspan></text>' +
  "</svg>";

function svgToBase64(svg: string): string {
  // btoa only works in browser; in Node (build/server) use Buffer
  if (typeof Buffer !== "undefined") {
    return Buffer.from(svg).toString("base64");
  }
  return btoa(svg);
}

/**
 * Stamped into every generated recovery file's BACKUP_DATA blob (centrally, in
 * generateBackupHtml — never per caller). Bumped only on a breaking change to
 * the file format. Restore is gated to fileVersion === 1 in restore-from-file.ts:
 * pre-version files (legacy plaintext or old encrypted, neither carrying this
 * field) are rejected. Old files provably cannot carry it — the field did not
 * exist when they were produced.
 */
export const RECOVERY_FILE_VERSION = 1;

export interface BackupData {
  name: string;
  address: string;
  wif_encrypted?: string; // AES-256-GCM encrypted — requires passphrase to reveal
  pathType: "save" | "restore-pre";
  hint?: string; // memory clue (plaintext, stored verbatim)
  createdAt: string;
  note?: string;
  fileVersion?: number; // stamped centrally in generateBackupHtml — do not set per-caller
}

/** Escape a value for use in HTML body or attribute. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format the saved date for display. Uses fixed `en-US` locale (not the
 * runtime default) so the output is stable across server locales — Vercel,
 * Railway, and Windows dev machines all differ in their default `Intl`
 * resolution. `generateBackupHtml` runs in the browser today (called from
 * `downloadBackup`), so this resolves to the user's browser locale by
 * `new Date().toString()` defaults — but pinning the *display* locale to
 * `en-US` keeps the rendered file consistent regardless of where it's
 * opened later.
 */
function formatSavedDate(createdAt: string): string {
  try {
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return createdAt || "—";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return createdAt || "—";
  }
}

/**
 * Builds the filename for a backup download.
 *
 * Pattern: openbook-<pathType>-<anon_name>-<addr6>-<YYYY-MM-DD-HHmm>.html
 *
 * addr6 = address.slice(1, 7)  (skip leading '1' of P2PKH, take next 6 chars)
 */
function buildFilename(data: BackupData): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const datePart = `${yyyy}-${mm}-${dd}-${hh}${min}`;

  const addrPart = data.address.slice(1, 7);

  // Sanitise anon name: keep alphanumeric + underscore, replace others with hyphen
  const safeName = data.name.replace(/[^a-zA-Z0-9_]/g, "-");

  return `openbook-${data.pathType}-${safeName}-${addrPart}-${datePart}.html`;
}

/**
 * Returns a complete, self-contained HTML document as a string.
 * Embed it in a Blob and download as `.html`.
 *
 * Behaviour: the embedded key is always encrypted (`wif_encrypted`) — the file
 * shows a passphrase input + PBKDF2/AES-GCM decrypt flow. There is no plaintext
 * variant; no unencrypted recovery file is ever produced.
 */
export function generateBackupHtml(data: BackupData): string {
  const iconB64 = svgToBase64(ICON_SVG);
  const faviconUri = `data:image/svg+xml;base64,${iconB64}`;

  // Safe JSON embed — JSON.stringify handles all escaping. Stamp the format
  // version centrally so EVERY emitted file carries it, regardless of which
  // caller built the BackupData (spread-then-override guarantees the stamp wins).
  const dataJson = JSON.stringify({ ...data, fileVersion: RECOVERY_FILE_VERSION });

  const title = `OpenBooks Recovery — ${data.name}`;

  // Resolved at template-build time so iOS Files Quick Look (which blocks
  // inline JS in local HTML previews) renders these values without needing
  // a script to run. Same reason every dynamic field below is interpolated
  // into HTML rather than injected via `document.getElementById(...).textContent`.
  const savedDate = formatSavedDate(data.createdAt);
  const footerStamp = `Recovery file · ${data.pathType} · saved ${savedDate}`;

  // ── Per-variant context block ───────────────────────────────────────────────
  // Sits beneath the metadata card. Tells the user what THIS file is and where
  // their posts/earnings live. One or two sentences, no jargon, variant-specific.
  function contextBlockText(): string {
    switch (data.pathType) {
      case "restore-pre":
        return "This is a snapshot of the account that was on this device before you restored. If you need to go back, this file is your way in.";
      default:
        return "This file lets you recover your OpenBooks account on any device. Your posts and earnings are tied to the address above.";
    }
  }

  // ── WIF warning helper ──────────────────────────────────────────────────────
  // Single paragraph: anyone who holds this key controls the account.
  function wifWarningHtml(): string {
    return [
      '      <div class="wif-warning">',
      "        <p>&#9888; Anyone who has this secret key controls your account and any funds in it. Never share it &mdash; not with support, not with friends, not with anyone.</p>",
      "      </div>",
    ].join("\n");
  }

  // ── Body section ────────────────────────────────────────────────────────────
  // The current-key block does NOT repeat the public address — it's already in
  // the metadata card at the top. The previous-key block DOES show the previous
  // address, because that's the only place it appears.
  const bodySection = [
    "    <!-- Encrypted recovery file: passphrase required -->",
    '    <div class="card" id="decrypt-section">',
    data.hint
      ? `      <div class="hint-box"><strong>Memory clue:</strong> ${escapeHtml(data.hint)}</div>`
      : "",
    '      <label for="passphrase-input">Enter your passphrase to unlock your secret key</label>',
    '      <input type="password" id="passphrase-input" placeholder="Your passphrase" autocomplete="current-password" onfocus="this.scrollIntoView({block:\'center\'})" />',
    '      <button class="primary" id="decrypt-btn" onclick="handleDecrypt()">Decrypt</button>',
    "    </div>",
    "",
    "    <!-- Quick Look notice, placed BELOW the decrypt panel (people try decrypt",
    "         first, then read this). Visible by default in renderers that don't run",
    "         JS (iOS Files / Quick Look, email previews); the inline script right",
    "         after it hides it synchronously where JS runs, so a real browser never",
    "         flashes it. We can't use <noscript> — iOS Quick Look reports scripting",
    "         'enabled' at the engine level even though it never executes scripts. -->",
    '    <div id="quicklook-notice" class="noscript-banner">',
    "      <strong>Your key is safe &mdash; but this preview can't unlock it.</strong>",
    "      <p>Phones usually can't run the code this file needs to decrypt. Your secret key is still safely encrypted with your passphrase.</p>",
    "      <p><strong>To unlock it:</strong></p>",
    "      <ul>",
    "        <li><strong>Open it on a computer</strong> &mdash; open this file in any browser (Chrome, Safari, Firefox, Edge) on a Mac or PC and enter your passphrase.</li>",
    "        <li><strong>Or restore it in OpenBooks</strong> &mdash; open the You menu and tap <em>Restore</em>; decryption happens inside the app.</li>",
    "      </ul>",
    "    </div>",
    "    <script>document.getElementById('quicklook-notice').style.display='none';</script>",
    "",
    '    <div id="spinner" class="spinner"></div>',
    "",
    '    <div class="card" id="result-section" style="display:none">',
    '      <div class="success-header">',
    '        <div class="check-icon">',
    '          <svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '            <polyline points="2,6 5,9 10,3"></polyline>',
    "          </svg>",
    "        </div>",
    "        <h3>Key unlocked</h3>",
    "      </div>",
    '      <div id="wif-primary-block" style="display:none">',
    '        <div class="wif-block">',
    '          <div class="wif-label">Your secret key (WIF)</div>',
    '          <textarea class="wif-value" id="wif-primary" readonly rows="2"></textarea>',
    "        </div>",
    wifWarningHtml(),
    "      </div>",
    "    </div>",
    "",
    '    <div id="error-box" class="error-box">',
    "      <strong>Decryption failed</strong>",
    "      Wrong passphrase or corrupted data. Check your passphrase and try again.",
    "    </div>",
  ].join("\n");

  // ── Variant-specific JS body (injected after the universal helpers) ─────────
  // Recovery files are always encrypted now — this is the decrypt flow. The
  // Copy button on the metadata Address row uses copyText() when JS is
  // available; it degrades to long-press select in iOS Quick Look thanks to
  // the form-control text selection on `.meta-value`.
  const variantJs = [
    "    // ⚠ THIS MUST DECRYPT EVERY FORMAT crypto.ts HAS EVER WRITTEN.",
    "    // This script is FROZEN INTO EACH FILE at save time, so a file saved",
    "    // today must still open years from now — and, far worse, a file saved",
    "    // by a version that could not read its own output is a backup that has",
    "    // never worked and says nothing about it. That happened: crypto.ts moved",
    "    // to V2 ('enc2:', recorded iterations) and this script kept looking for",
    "    // V1 ('enc:', 100000 hardcoded), so every file emitted after the change",
    "    // rejected the correct passphrase. Add new formats here IN THE SAME",
    "    // COMMIT that adds them to crypto.ts, and never delete an old one.",
    "    //   V1  'enc:'   base64( salt(16) | iv(12) | ciphertext ), 100000 iters",
    "    //   V2  'enc2:'  base64( ver(1) | iters(4 BE) | salt(16) | iv(12) | ct )",
    "    const LEGACY_PBKDF2_ITERATIONS = 100000;",
    "    const SALT_BYTES = 16;",
    "    const IV_BYTES = 12;",
    "    const ENCRYPTED_PREFIX = 'enc:';",
    "    const ENCRYPTED_PREFIX_V2 = 'enc2:';",
    "",
    "    // Order matters: 'enc2:' also starts with 'enc', so V2 is tested first.",
    "    // ⚠ Wrapped: atob() THROWS on malformed base64, and a throw here escapes",
    "    // decryptStr's own try/catch and takes the page down with an unhandled",
    "    // rejection. A truncated or mangled file must report a problem, not die.",
    "    function parseEncrypted(encryptedStr) {",
    "      try {",
    "      if (!encryptedStr) return null;",
    "      if (encryptedStr.startsWith(ENCRYPTED_PREFIX_V2)) {",
    "        const raw = Uint8Array.from(atob(encryptedStr.slice(ENCRYPTED_PREFIX_V2.length)), c => c.charCodeAt(0));",
    "        if (raw.length < 5 + SALT_BYTES + IV_BYTES) return null;",
    "        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);",
    "        const iterations = view.getUint32(1, false);",
    "        let o = 5;",
    "        const salt = raw.slice(o, o + SALT_BYTES); o += SALT_BYTES;",
    "        const iv = raw.slice(o, o + IV_BYTES); o += IV_BYTES;",
    "        return { salt: salt, iv: iv, ciphertext: raw.slice(o), iterations: iterations };",
    "      }",
    "      if (encryptedStr.startsWith(ENCRYPTED_PREFIX)) {",
    "        const raw = Uint8Array.from(atob(encryptedStr.slice(ENCRYPTED_PREFIX.length)), c => c.charCodeAt(0));",
    "        if (raw.length < SALT_BYTES + IV_BYTES) return null;",
    "        return {",
    "          salt: raw.slice(0, SALT_BYTES),",
    "          iv: raw.slice(SALT_BYTES, SALT_BYTES + IV_BYTES),",
    "          ciphertext: raw.slice(SALT_BYTES + IV_BYTES),",
    "          iterations: LEGACY_PBKDF2_ITERATIONS",
    "        };",
    "      }",
    "      return null;",
    "      } catch { return null; }",
    "    }",
    "",
    "    async function decryptStr(encryptedStr, passphrase) {",
    "      const parsed = parseEncrypted(encryptedStr);",
    "      if (!parsed) return null;",
    "      try {",
    "        const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);",
    "        const key = await crypto.subtle.deriveKey(",
    "          { name: 'PBKDF2', salt: parsed.salt.buffer, iterations: parsed.iterations, hash: 'SHA-256' },",
    "          keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']",
    "        );",
    "        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv.buffer }, key, parsed.ciphertext.buffer);",
    "        return new TextDecoder().decode(plain);",
    "      } catch { return null; }",
    "    }",
    "",
    "    async function handleDecrypt() {",
    "      const passphrase = document.getElementById('passphrase-input').value;",
    "      document.getElementById('result-section').style.display = 'none';",
    "      document.getElementById('error-box').style.display = 'none';",
    "      if (!passphrase) { showError('Please enter your passphrase.'); return; }",
    "      setLoading(true);",
    "      try {",
    "        const primaryWif = await decryptStr(BACKUP_DATA.wif_encrypted, passphrase);",
    "        if (!primaryWif) { setLoading(false); showError(null); return; }",
    "        setLoading(false);",
    "        showSuccess(primaryWif);",
    "      } catch (err) {",
    "        setLoading(false);",
    "        showError('Unexpected error: ' + err.message);",
    "      }",
    "    }",
    "",
    "    document.getElementById('passphrase-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleDecrypt(); });",
    "",
    "    function setLoading(on) {",
    "      const btn = document.getElementById('decrypt-btn');",
    "      const spinner = document.getElementById('spinner');",
    "      btn.disabled = on; btn.textContent = on ? 'Decrypting…' : 'Decrypt';",
    "      spinner.style.display = on ? 'block' : 'none';",
    "    }",
    "",
    "    function showSuccess(primary) {",
    "      document.getElementById('wif-primary').value = primary;",
    "      document.getElementById('wif-primary-block').style.display = 'block';",
    "      document.getElementById('result-section').style.display = 'block';",
    "    }",
    "",
    "    function showError(msg) {",
    "      const el = document.getElementById('error-box');",
    "      if (msg) el.innerHTML = '<strong>Error</strong>' + esc(msg);",
    "      else el.innerHTML = '<strong>Decryption failed</strong>Wrong passphrase or corrupted data. Check your passphrase and try again.';",
    "      el.style.display = 'block';",
    "    }",
  ].join("\n");

  return (
    "<!DOCTYPE html>\n" +
    "<!-- No network calls. Verify: View Source. -->\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    "  <title>" +
    escapeHtml(title) +
    "</title>\n" +
    '  <link rel="icon" href="' +
    faviconUri +
    '" />\n' +
    "  <style>\n" +
    "    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n" +
    // Hardening tried against an Android Chrome scroll-jitter (the page is ~one viewport
    // tall, so the URL-bar-collapse zone is the only scrollable region and Chrome
    // overscroll-re-clamps to the top). NONE of it fully fixed the jitter — it is inherent
    // Android Chrome behavior (WON'T-FIX, see DECISIONS); iPhone is fine. These rules are
    // correct + harmless and stay: no viewport units (dark bg on `html`, not a
    // `min-height:100vh` the URL bar would track) + `overflow-anchor:none` +
    // `overscroll-behavior-y:none` on `html` (the document scroller — no-ops on `body`).
    "    html { background: #09090b; overflow-anchor: none; overscroll-behavior-y: none; }\n" +
    "    body {\n" +
    "      background: #09090b; color: #f4f4f5;\n" +
    "      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n" +
    "      display: flex; flex-direction: column;\n" +
    "      align-items: center; padding: 48px 16px 32px;\n" +
    "    }\n" +
    "    .container { width: 100%; max-width: 560px; }\n" +
    "    .logo { font-size: 22px; font-weight: 700; letter-spacing: 0.04em; color: #f4f4f5; margin-bottom: 6px; text-align: center; }\n" +
    "    .logo span { color: #fbbf24; }\n" +
    "    h1 { font-size: 17px; font-weight: 600; color: #f4f4f5; text-align: center; margin-bottom: 6px; }\n" +
    "    .subtitle { font-size: 13px; color: #71717a; text-align: center; line-height: 1.5; margin-bottom: 28px; }\n" +
    "    .offline-badge {\n" +
    "      display: inline-flex; align-items: center; gap: 5px;\n" +
    "      background: #1a2e1a; border: 1px solid #166534; border-radius: 20px;\n" +
    "      font-size: 11px; font-weight: 500; color: #4ade80;\n" +
    "      padding: 3px 10px; margin: 0 auto 20px; letter-spacing: 0.02em;\n" +
    "    }\n" +
    "    .offline-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #4ade80; }\n" +
    "    .badge-wrap { display: flex; justify-content: center; }\n" +
    "    /* Shown only when JS is disabled (iOS Quick Look, email previews, etc.) */\n" +
    "    .noscript-banner {\n" +
    "      background: #422006; border: 1px solid #b45309; border-radius: 10px;\n" +
    "      padding: 13px 16px; margin-bottom: 16px;\n" +
    "      font-size: 13px; color: #fbbf24; line-height: 1.55;\n" +
    "    }\n" +
    "    .noscript-banner strong { color: #fde68a; font-weight: 600; }\n" +
    // Hide the Quick Look notice via CSS the instant JS runs (the <script> in <head>
    // adds `.js` to <html> BEFORE the body paints), so the amber notice never
    // shows-then-collapses on load — this removes a genuine ~150px load-time FLASH (a
    // real improvement). It was NOT the cause of the scroll-jitter (that's inherent
    // Android Chrome). Quick Look runs no JS → no `.js` class → the notice stays visible.
    "    html.js #quicklook-notice { display: none; }\n" +
    "    .context-block {\n" +
    "      background: #18181b; border: 1px solid #27272a; border-radius: 10px;\n" +
    "      padding: 13px 16px; margin-bottom: 14px;\n" +
    "      font-size: 13px; color: #d4d4d8; line-height: 1.55;\n" +
    "    }\n" +
    "    .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 24px; margin-bottom: 14px; }\n" +
    "    .meta-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; margin-bottom: 6px; gap: 12px; }\n" +
    "    .meta-row.with-copy { align-items: center; }\n" +
    "    .meta-label { color: #71717a; flex-shrink: 0; }\n" +
    '    /* Used by both <span> (name, saved date) and <input type="text" readonly>\n' +
    "       (address rows). The input variants need defaults stripped so they look\n" +
    "       visually identical to spans, plus they pick up native iOS text-selection\n" +
    "       affordance in Quick Look (which CSS user-select: all does not). */\n" +
    "    .meta-value { color: #a1a1aa; font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all; text-align: right; flex: 1; background: transparent; border: 0; padding: 0; margin: 0; font-size: inherit; min-width: 0; }\n" +
    "    .meta-value:focus { outline: none; }\n" +
    "    .meta-value.name { color: #f4f4f5; font-weight: 600; font-family: inherit; }\n" +
    "    .meta-copy-btn {\n" +
    "      background: transparent; border: 1px solid #3f3f46; border-radius: 5px;\n" +
    "      color: #71717a; font-size: 10px; font-weight: 500; padding: 3px 8px;\n" +
    "      cursor: pointer; transition: background 0.15s, color 0.15s; flex-shrink: 0;\n" +
    "    }\n" +
    "    .meta-copy-btn:hover { background: #27272a; color: #f4f4f5; }\n" +
    "    .meta-copy-btn.copied { background: #14532d; border-color: #166534; color: #4ade80; }\n" +
    "    label { display: block; font-size: 12px; font-weight: 500; color: #a1a1aa; margin-bottom: 7px; letter-spacing: 0.01em; }\n" +
    '    input[type="password"] {\n' +
    "      width: 100%; background: #09090b; border: 1px solid #3f3f46;\n" +
    "      border-radius: 8px; color: #f4f4f5; font-size: 14px;\n" +
    "      padding: 10px 13px; outline: none; transition: border-color 0.15s;\n" +
    "      letter-spacing: 0.06em; margin-bottom: 12px;\n" +
    "    }\n" +
    '    input[type="password"]:focus { border-color: #10b981; }\n' +
    '    input[type="password"]::placeholder { letter-spacing: 0; color: #52525b; }\n' +
    "    .hint-box {\n" +
    "      background: #1c1917; border: 1px solid #44403c; border-radius: 7px;\n" +
    "      padding: 9px 13px; font-size: 12px; color: #d97706; margin-bottom: 12px;\n" +
    "    }\n" +
    "    .hint-box strong { color: #fbbf24; }\n" +
    "    button.primary {\n" +
    "      width: 100%; background: #10b981; color: #fff; border: none;\n" +
    "      border-radius: 8px; font-size: 14px; font-weight: 600; padding: 11px;\n" +
    "      cursor: pointer; transition: background 0.15s;\n" +
    "    }\n" +
    "    button.primary:hover:not(:disabled) { background: #059669; }\n" +
    "    button.primary:disabled { opacity: 0.5; cursor: not-allowed; }\n" +
    "    .spinner {\n" +
    "      display: none; width: 18px; height: 18px; border: 2px solid #3f3f46;\n" +
    "      border-top-color: #10b981; border-radius: 50%;\n" +
    "      animation: spin 0.7s linear infinite; margin: 0 auto 14px;\n" +
    "    }\n" +
    "    @keyframes spin { to { transform: rotate(360deg); } }\n" +
    "    .address-section { margin-bottom: 12px; }\n" +
    "    .address-label { font-size: 10px; font-weight: 500; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }\n" +
    "    .address-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n" +
    "    .address-value { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: #a1a1aa; word-break: break-all; flex: 1; }\n" +
    "    .wif-block { background: #09090b; border: 1px solid #3f3f46; border-radius: 8px; padding: 12px; margin-bottom: 8px; }\n" +
    "    .wif-label { font-size: 10px; font-weight: 500; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }\n" +
    "    /* <textarea readonly> for iOS Quick Look-friendly tap-to-select. Defaults\n" +
    "       stripped so the textarea visually matches the surrounding card. */\n" +
    "    .wif-value { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #f4f4f5; word-break: break-all; line-height: 1.6; width: 100%; background: transparent; border: 0; padding: 0; margin: 0; resize: none; display: block; }\n" +
    "    .wif-value:focus { outline: none; }\n" +
    "    .wif-warning { margin-top: 8px; margin-bottom: 12px; }\n" +
    "    .wif-warning p { font-size: 11px; color: #fca5a5; line-height: 1.55; margin-bottom: 4px; }\n" +
    "    .wif-warning p:last-child { margin-bottom: 0; }\n" +
    "    .wif-warning strong { color: #fecaca; font-weight: 600; }\n" +
    "    .copy-btn {\n" +
    "      background: #27272a; border: 1px solid #3f3f46; border-radius: 6px;\n" +
    "      color: #a1a1aa; font-size: 11px; font-weight: 500; padding: 5px 11px;\n" +
    "      cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap;\n" +
    "    }\n" +
    "    .copy-btn:hover { background: #3f3f46; color: #f4f4f5; }\n" +
    "    .copy-btn.copied { background: #14532d; border-color: #166534; color: #4ade80; }\n" +
    "    .success-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }\n" +
    "    .check-icon {\n" +
    "      width: 20px; height: 20px; background: #10b981; border-radius: 50%;\n" +
    "      display: flex; align-items: center; justify-content: center; flex-shrink: 0;\n" +
    "    }\n" +
    "    .check-icon svg { width: 12px; height: 12px; }\n" +
    "    .success-header h3 { font-size: 13px; font-weight: 600; color: #10b981; }\n" +
    "    .error-box {\n" +
    "      display: none; background: #1c0a09; border: 1px solid #7f1d1d;\n" +
    "      border-radius: 8px; padding: 13px; font-size: 13px; color: #fca5a5;\n" +
    "    }\n" +
    "    .error-box strong { color: #f87171; display: block; margin-bottom: 3px; }\n" +
    "    footer { text-align: center; font-size: 11px; color: #52525b; margin-top: 28px; line-height: 1.7; }\n" +
    "    footer a { color: #71717a; text-decoration: none; }\n" +
    "    footer a:hover { color: #a1a1aa; }\n" +
    "    .footer-stamp { color: #3f3f46; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 10px; letter-spacing: 0.02em; margin-bottom: 4px; }\n" +
    "  </style>\n" +
    // Runs during <head> parse, before the body paints → `.js` on <html> makes the
    // CSS above hide #quicklook-notice from the very first layout (no reflow). See
    // DECISIONS "recovery flicker = scroll-anchoring + notice reflow".
    "  <script>document.documentElement.classList.add('js')</script>\n" +
    "</head>\n" +
    "<body>\n" +
    '  <div class="container">\n' +
    '    <div class="logo"><span>Open</span>Cook</div>\n' +
    "    <h1>Recovery File</h1>\n" +
    '    <p class="subtitle">Keep this file somewhere only you can find it.</p>\n' +
    '    <div class="badge-wrap"><div class="offline-badge">Works offline — no network calls</div></div>\n' +
    "\n" +
    '    <div class="card">\n' +
    '      <div class="meta-row">\n' +
    '        <span class="meta-label">Name</span>\n' +
    `        <span class="meta-value name">${escapeHtml(data.name)}</span>\n` +
    "      </div>\n" +
    // No Copy button — navigator.clipboard / execCommand fail in mobile file
    // previews but still flip to "Copied!" (false success). The address is a
    // tap-to-select <input readonly>: long-press → Select All copies the full
    // value on every platform. (QA 2026-06-23)
    '      <div class="meta-row">\n' +
    '        <span class="meta-label">Address</span>\n' +
    `        <input class="meta-value" id="meta-address" type="text" readonly value="${escapeHtml(data.address)}">\n` +
    "      </div>\n" +
    '      <div class="meta-row">\n' +
    '        <span class="meta-label">Saved</span>\n' +
    `        <span class="meta-value">${escapeHtml(savedDate)}</span>\n` +
    "      </div>\n" +
    "    </div>\n" +
    "\n" +
    '    <div class="context-block">' +
    escapeHtml(contextBlockText()) +
    "</div>\n" +
    "\n" +
    bodySection +
    "\n" +
    "\n" +
    "    <footer>\n" +
    `      <div class="footer-stamp">${escapeHtml(footerStamp)}</div>\n` +
    '      <a href="https://opencook.fun" target="_blank" rel="noopener">opencook.fun</a>\n' +
    "    </footer>\n" +
    "  </div>\n" +
    "\n" +
    "  <script>\n" +
    "    // @BACKUP_DATA_START\n" +
    "    const BACKUP_DATA = " +
    dataJson +
    ";\n" +
    "    // @BACKUP_DATA_END\n" +
    "\n" +
    "    function esc(str) {\n" +
    "      return String(str)\n" +
    "        .replace(/&/g, '&amp;').replace(/</g, '&lt;')\n" +
    "        .replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n" +
    "    }\n" +
    "\n" +
    "    // Universal copy helper — used by both the metadata Address row and any\n" +
    "    // Copy button inside the variant body (e.g., the previous-address row).\n" +
    "    // Reads `.value` from form inputs (the new tap-to-select friendly pattern\n" +
    "    // for iOS Quick Look) or `.textContent` from span/div elements (the\n" +
    "    // 'Saved' date row is still a span).\n" +
    "    function copyText(id, btn) {\n" +
    "      const el = document.getElementById(id);\n" +
    "      const text = 'value' in el ? el.value : el.textContent;\n" +
    "      const original = btn.textContent;\n" +
    "      navigator.clipboard.writeText(text).then(() => {\n" +
    "        btn.textContent = 'Copied!'; btn.classList.add('copied');\n" +
    "        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);\n" +
    "      }).catch(() => {\n" +
    "        // Fallback for browsers without async clipboard API. Inputs/textareas\n" +
    "        // use their native .select(); other elements use a Range.\n" +
    "        if (typeof el.select === 'function') { el.select(); }\n" +
    "        else {\n" +
    "          const range = document.createRange(); range.selectNodeContents(el);\n" +
    "          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);\n" +
    "        }\n" +
    "        document.execCommand('copy');\n" +
    "        if (window.getSelection) window.getSelection().removeAllRanges();\n" +
    "        btn.textContent = 'Copied!'; btn.classList.add('copied');\n" +
    "        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);\n" +
    "      });\n" +
    "    }\n" +
    "\n" +
    "    // Hide the Quick Look notice — it's the inverse-noscript pattern: visible by\n" +
    "    // default for renderers that don't run JS (iOS Files / Quick Look, email\n" +
    "    // previews), hidden the moment JS runs in a real browser.\n" +
    "    (function hideQuickLookNotice() {\n" +
    "      const el = document.getElementById('quicklook-notice');\n" +
    "      if (el) el.style.display = 'none';\n" +
    "    })();\n" +
    "\n" +
    // Metadata (name, address, saved date) and footer stamp render statically
    // at template-build time — no JS required so iOS Files Quick Look /
    // macOS Finder Quick Look / email previews can show them. The script
    // block below is only needed for the encrypted-decrypt flow and the
    // Copy button on the metadata Address row.
    variantJs +
    "\n" +
    "  </script>\n" +
    "</body>\n" +
    "</html>"
  );
}

/**
 * Download a backup as a self-contained HTML file via classic `<a download>`.
 * Used as the FALLBACK path when the Web Share API isn't available, and as the
 * sync emergency path (e.g. mid-flight rotation failure auto-emit) where async
 * share would complicate the error recovery flow.
 *
 * The filename is auto-generated from BackupData fields.
 */
export function downloadBackup(data: BackupData): void {
  const html = generateBackupHtml(data);
  const filename = buildFilename(data);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Result of `shareOrDownloadBackup`. Caller uses this to decide whether to
 * mark the address as saved (`shared`) or leave the "unsaved" badge in place
 * (`cancelled` or `failed`).
 */
export interface ShareResult {
  /** User picked a destination AND the share / download completed. */
  shared: boolean;
  /** User dismissed the iOS share sheet without picking a destination. */
  cancelled: boolean;
}

/**
 * Share a backup file using the Web Share API where available, falling back
 * to `<a download>`. On iOS Safari 15.4+ / PWA on 16+, this opens the native
 * share drawer ("Save to Files" appears as a top-level option) instead of
 * the intrusive full-screen download sheet.
 *
 * Critical iOS implementation notes (informed by Web Share API spec +
 * community reports — see DECISIONS.md "Web Share API for recovery files"):
 *
 * - **Build the File synchronously in the click handler before any `await`.**
 *   iOS Safari's transient activation token expires across async boundaries,
 *   which is why this function takes a synchronously-constructable BackupData
 *   and does the html-generation + File-construction inline.
 * - **MIME type is `text/html` (E28a, 2026-05-25).** Earlier E27 used
 *   `application/octet-stream` on a researcher's "iOS treats text/html as
 *   hostile" guidance, but iPhone PWA testing showed the share drawer never
 *   appeared at all (silent fallback to `<a download>`). Current research +
 *   community consensus is that WebKit's PWA process uses a stricter file-MIME
 *   allow-list than Safari tab, and `text/html` is reliably on that list.
 *   The diagnostic logs added in E28a will confirm the actual behavior; if
 *   share still rejects, we may need to add an explicit user-visible fallback
 *   instead of relying on silent `<a download>`.
 * - **Do NOT pass `title` alongside `files`.** iOS treats `title` as a
 *   separate text payload when files are present, saving it as a sidecar
 *   `.txt` file containing just the title string (E28a finding).
 * - **AbortError = user cancelled.** Do NOT fall back to `<a download>` on
 *   AbortError — that would re-trigger the intrusive download sheet AFTER
 *   the user deliberately dismissed the share drawer. UX regression.
 * - **Any non-AbortError falls back to `<a download>`.** Some browsers report
 *   `canShare` true but throw on `share` — always try/catch.
 *
 * The CALLER must wrap this invocation with `blockSessionClear()` /
 * `unblockSessionClear()` if the active flow has state-protection concerns —
 * the iOS share sheet fires `visibilitychange→hidden` and `pagehide` like
 * any other system sheet. See E26 for the block-ref pattern.
 */
/**
 * True when the device's PRIMARY input is touch (finger / stylus). False on
 * desktop-with-mouse, hybrid laptops with a mouse attached, and iPad with
 * Magic Keyboard/trackpad. This is posture-aware, not capability-aware: a
 * Surface Pro detached as a tablet returns true; the same device with a mouse
 * plugged in returns false. iPadOS 13.4+ also flips to fine pointer when a
 * trackpad is connected.
 *
 * Used by `shareOrDownloadBackup` to skip the OS-native share sheet on desktop
 * (E29a — macOS Chrome opens AirDrop/share, Windows Chrome opens Phone Link,
 * both of which are surprising compared to the plain `<a download>` desktop
 * users expect).
 */
function isTouchPrimary(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

export async function shareOrDownloadBackup(data: BackupData): Promise<ShareResult> {
  const html = generateBackupHtml(data);
  const filename = buildFilename(data);
  // text/html: WebKit's PWA process uses a stricter file-MIME allow-list than
  // Safari tab. text/html is reliably on the PWA list; application/octet-stream
  // was off it (E28a finding via iPhone PWA testing). See DECISIONS.md "Web
  // Share API for recovery files".
  const file = new File([html], filename, { type: "text/html" });

  // E29a: skip the Web Share API on desktop-with-mouse. On macOS Chrome /
  // Safari it opens the OS share sheet (AirDrop + nearby devices); on Windows
  // it opens Phone Link. Both are UX regressions vs the plain `<a download>`
  // desktop users expect. Keep the share path for touch-primary devices where
  // it's a genuine win (rounded iOS share drawer, one-tap Save to Files).
  if (!isTouchPrimary()) {
    downloadBackup(data);
    return { shared: true, cancelled: false };
  }

  const canShareSupported =
    typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  const canShareFiles = canShareSupported && navigator.canShare({ files: [file] }) === true;
  const shareSupported = typeof navigator?.share === "function";

  if (canShareFiles && shareSupported) {
    try {
      // No `title` field — iOS treats `title` alongside `files` as a separate
      // text payload, saved as a .txt sidecar file. Sharing the file alone
      // is the cleanest pattern (E28a finding).
      await navigator.share({ files: [file] });
      return { shared: true, cancelled: false };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { shared: false, cancelled: true };
      }
      // Real failure (not user-initiated) — fall through to <a download>.
    }
  }

  // Fallback: classic anchor-click download. Used when:
  // - Web Share API unavailable (older Safari, Firefox desktop, some PWAs)
  // - canShare returned false (file too large, MIME rejected, etc.)
  // - navigator.share threw a non-AbortError
  downloadBackup(data);
  return { shared: true, cancelled: false };
}

/**
 * Read the stored passphrase hint from encrypted identity storage.
 */
export function getStoredHint(): string | undefined {
  try {
    const raw = localStorage.getItem("bfn_keypair_enc");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { hint?: string };
    return parsed.hint || undefined;
  } catch {
    return undefined;
  }
}

// ── Per-address saved tracking ─────────────────────────────────────────────
//
// Existing `BACKED_UP_KEY` (in InstallContext.tsx) is a single global boolean
// that flips true on first-ever save. It drives the install pitch, the first-
// earning prompt, etc. We keep it as-is for those existing consumers.
//
// E27 adds a per-address flag layered on top: `openbook_saved:<addr6>` storing
// the ISO date of the most recent save for that address. Each rotation creates
// a new address, so users need to save once per identity — but global
// "backedUp ever?" semantics are preserved.
//
// `addr6 = address.slice(1, 7)` to match `buildFilename`'s addr6 convention
// (skip the leading "1" since all P2PKH addresses start with that).

const ADDR_SAVED_KEY_PREFIX = "openbook_saved:";

function addrSlug(address: string): string {
  return address.slice(1, 7);
}

/**
 * Mark a specific address as having a recovery file saved for it.
 * Called from the Save button handler AFTER share/download succeeds.
 */
export function markAddressSaved(address: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ADDR_SAVED_KEY_PREFIX + addrSlug(address), new Date().toISOString());
  } catch {
    /* localStorage quota / SecurityError — non-fatal */
  }
}

/**
 * True iff a Save event has been recorded for this address since import/rotation.
 * Drives the "Unsaved key" amber badge in IdentityBar.
 */
export function isAddressSaved(address: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ADDR_SAVED_KEY_PREFIX + addrSlug(address)) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the ISO date of the last save for this address, or null if never saved.
 * Useful for displaying "Last saved: 2 days ago" in the UI.
 */
export function getAddressSavedDate(address: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ADDR_SAVED_KEY_PREFIX + addrSlug(address));
  } catch {
    return null;
  }
}
