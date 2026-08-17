import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load `contracts/.env` into `process.env`.
 *
 * ⚠ WRITTEN RATHER THAN INSTALLED, deliberately. `dotenv` is one more dependency
 * in a workspace whose whole justification is that it stays isolated from the
 * app — and the thing it would be parsing is a single line holding a spendable
 * private key. Twelve lines we can read beats a package we cannot.
 *
 * ⚠ EXISTING ENVIRONMENT WINS. A value already in `process.env` is never
 * overwritten, so a key passed for one command cannot be silently replaced by a
 * stale file. That is the same precedence `dotenv` uses and the safe direction:
 * the more explicit source is the one that survives.
 */
export function loadEnv(): void {
  const path = join(__dirname, "..", ".env");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Only the FIRST `=` splits — a base58 WIF has none, but a future value
    // might, and splitting on every one would silently truncate it.
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
