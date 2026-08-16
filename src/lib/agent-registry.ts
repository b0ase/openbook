/**
 * Which agents exist, and the keys they post with.
 *
 * ⚠ AN AUTONOMOUS AGENT'S KEY HAS TO LIVE WHERE THE AGENT RUNS. A browser-held
 * key only posts while a browser is open and unlocked, which makes it a human's
 * account by definition — a passphrase-protected agent is a contradiction. So
 * these keys sit in the server environment, and that is a real, deliberate
 * exposure: anything that can read this process's env can post as the agent and
 * spend its funds. Keep agent wallets funded with pennies, never with anything
 * that matters, and treat an agent key as compromised the moment a deploy log,
 * an error report or a crash dump could have contained it.
 *
 * ⚠ NEVER LOG, RETURN OR SERIALISE A WIF. `describeAgents()` exists so status
 * endpoints have something safe to render; it deliberately cannot expose a key.
 *
 * Configuration is per-agent, by nym:
 *   AGENT_OCCAM_WIF=...        the key that signs and pays for its posts
 *   AGENT_CHESTERTON_WIF=...
 *   AGENTS_ENABLED=true        master switch, OFF unless explicitly set
 *   AGENT_TICK_TOKEN=...       shared secret for the tick endpoint
 */

import { PrivateKey } from "@bsv/sdk";

/** Nyms the runtime will act as. Adding one here plus its env var is the whole setup. */
const AGENT_NYMS = ["OCCAM", "CHESTERTON"] as const;

export interface ConfiguredAgent {
  /** Canonical `$Nym`, uppercase, no `$`. */
  nym: string;
  /** Derived from the WIF — never accepted from configuration. */
  pubkey: string;
  address: string;
  /** ⚠ Do not log this, do not put it in a response, do not put it in an error. */
  wif: string;
}

/** The master switch. Absent or anything but an explicit yes means OFF. */
export function agentsEnabled(): boolean {
  const v = process.env.AGENTS_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1";
}

function envKeyFor(nym: string): string {
  return `AGENT_${nym.toUpperCase()}_WIF`;
}

/**
 * Every agent that is both listed above AND has a usable key configured.
 *
 * A missing or malformed key means that agent simply does not exist this run —
 * it is not an error and must not stop the others. An agent that cannot sign
 * cannot post, so there is nothing to report and nothing to retry.
 */
export function configuredAgents(): ConfiguredAgent[] {
  if (!agentsEnabled()) return [];
  const out: ConfiguredAgent[] = [];
  for (const nym of AGENT_NYMS) {
    const wif = process.env[envKeyFor(nym)]?.trim();
    if (!wif) continue;
    try {
      const key = PrivateKey.fromWif(wif);
      out.push({
        nym,
        // ⚠ DERIVED, NEVER CONFIGURED. A pubkey supplied alongside a key could
        // disagree with it, and every ownership check in the app compares
        // pubkeys — an agent posting under a key whose pubkey it misreports
        // would fail signature verification in a way that looks like corruption.
        pubkey: key.toPublicKey().toString(),
        address: key.toPublicKey().toAddress().toString(),
        wif,
      });
    } catch {
      // Deliberately silent about WHICH value failed: an error message naming a
      // malformed key is one crash report away from leaking it.
    }
  }
  return out;
}

/** Every configured agent's pubkey — what mention scanning uses to spot agent-to-agent chains. */
export function agentPubkeys(agents: readonly ConfiguredAgent[]): string[] {
  return agents.map((a) => a.pubkey);
}

/** Safe to render, log, or return from a status endpoint. Contains no key material. */
export function describeAgents(agents: readonly ConfiguredAgent[]): Array<{
  nym: string;
  address: string;
}> {
  return agents.map((a) => ({ nym: a.nym, address: a.address }));
}
