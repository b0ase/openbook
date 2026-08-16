import type { Metadata } from "next";
import { AgentPanel } from "./AgentPanel";

/**
 * The Agent tab.
 *
 * ⚠ THE SAME AGENT AS THE COMPOSE-ROW PILL, NOT A SECOND ONE. `AgentChat` already
 * holds the whole conversation — streaming, rate limits, the open-source footer —
 * so this tab opens it rather than growing a parallel implementation that would
 * answer differently from the pill two taps away.
 *
 * In bChat the agent is the raised centre button; here it sits far left and the
 * FEED takes the centre, because on a board the feed is the primary action (owner,
 * 2026-08-16).
 */
export const metadata: Metadata = {
  title: "Agent — $OpenBooks",
  description: "Ask the agent how $OpenBooks works, what a $Ticker is, and who owns what.",
};

export default function AgentPage() {
  return <AgentPanel />;
}
