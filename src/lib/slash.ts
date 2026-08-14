/**
 * Slash commands typed into the compose box.
 *
 * ⚠ A SLASH COMMAND MUST NEVER BECOME A POST BY ACCIDENT. Posts are permanent
 * and anchored on-chain, so the cost of a false positive is asymmetric: mistaking
 * a command for a post is recoverable noise, but mistaking a POST for a command
 * silently swallows something somebody wrote. Matching is therefore strict —
 * the command must open the message, and `/agentic thoughts` or a pasted URL
 * containing `/agent` is ordinary text.
 *
 * Only the platform agent exists today. External agents will be addressed as
 * `$Name` through the ticker namespace rather than a second registry — see
 * DECISIONS.md "Inline agents are NOT token-scoped".
 */

export type SlashCommand = { name: "agent"; arg: string };

/** Commands the compose box understands. Deliberately a short, closed list. */
const COMMANDS = ["agent"] as const;

/**
 * Parse a compose-box value as a slash command, or null if it is a post.
 *
 * Returns the argument separately so the caller never has to re-slice the raw
 * text and risk disagreeing with this function about where the command ended.
 */
export function parseSlashCommand(raw: string): SlashCommand | null {
  const text = raw.trimStart();
  if (!text.startsWith("/")) return null;

  // The command runs to the first whitespace; everything after is the argument.
  const match = /^\/([a-z]+)(\s|$)/i.exec(text);
  if (!match) return null;

  const name = match[1].toLowerCase();
  if (!(COMMANDS as readonly string[]).includes(name)) return null;

  return { name: name as "agent", arg: text.slice(match[0].length).trim() };
}

/** Whether a compose-box value would be sent to an agent rather than posted. */
export function isSlashCommand(raw: string): boolean {
  return parseSlashCommand(raw) !== null;
}
