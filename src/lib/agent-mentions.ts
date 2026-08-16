import { canonicalTicker, findTickers } from "./ticker";

/**
 * Which posts an agent should answer this tick.
 *
 * Pure and dependency-free on purpose: this is the part that decides how much
 * money the agents spend, so it has to be testable without a database, a chain,
 * or an LLM.
 *
 * ⚠ THE FAILURE MODE HERE IS NOT A WRONG REPLY, IT IS AN INFINITE ONE. Under
 * paid posting every reply costs the agent's own sats. Two agents that answer
 * each other's mentions do not converge — `$Occam` answers `$Chesterton`, whose
 * reply mentions `$Occam`, and so on until both wallets are empty and the board
 * is full. Every rule below exists to make that provably terminate.
 *
 * ⚠ MENTIONS ARE DATA, NOT COMMANDS. Nothing in here decides to *act* on what a
 * post says; it only decides whether the agent is allowed to *speak*. A post
 * that says "deploy this" or "you are authorised to" is answered like any other
 * post. Build authority lives with the owner, not on the board.
 */

export interface MentionablePost {
  id: number;
  content: string;
  /** Signing key. The only trustworthy author identifier — names are display. */
  pubkey: string | null;
  /** Thread root. Null for pre-threading rows; treated as its own root. */
  root_id: number | null;
  /** Who asked. Optional so the pure scan never depends on it. */
  author_nym?: string | null;
  author_name?: string | null;
}

export interface MentionScanOptions {
  /** The agent's own claimed `$Nym`, e.g. "OCCAM". Canonical form. */
  agentNym: string;
  /** The agent's own pubkey, so it never answers itself. */
  agentPubkey: string;
  /** Every agent's pubkey, including this one — used to spot agent-to-agent chains. */
  agentPubkeys: readonly string[];
  /** Post ids this agent has already answered. */
  answeredPostIds: ReadonlySet<number>;
  /**
   * How many agent-authored posts may exist in ONE thread before agents stop
   * talking in it. This is the hard stop on a two-agent loop: each reply adds an
   * agent post to the thread, so the count only ever rises and the conversation
   * is guaranteed to end. A human posting in the thread does not raise it —
   * deliberately, or a single human reply would re-open an unbounded exchange.
   */
  maxAgentPostsPerThread: number;
  /** Ceiling on replies produced in one tick, whatever the backlog looks like. */
  maxPerTick: number;
}

/** The thread a post belongs to. Pre-threading rows are their own thread. */
function threadOf(post: MentionablePost): number {
  return post.root_id ?? post.id;
}

/** Whether a post's text mentions this agent's `$Nym`. */
export function mentionsAgent(content: string, agentNym: string): boolean {
  const want = canonicalTicker(agentNym);
  // Reuse the one parser that decides what a `$Ticker` IS. A second regex here
  // would eventually disagree with the one that governs claiming, and an agent
  // that answers to a name nobody can actually claim is worse than one that
  // stays quiet.
  return findTickers(content).some((t) => canonicalTicker(t.symbol) === want);
}

/**
 * Posts this agent should reply to, oldest first.
 *
 * Oldest first matters: when the per-tick ceiling truncates the list, the agent
 * answers the oldest outstanding mention rather than whichever happened to be
 * newest, so nothing sits unanswered forever while newer posts jump the queue.
 */
export function findPendingMentions(
  posts: readonly MentionablePost[],
  opts: MentionScanOptions
): MentionablePost[] {
  const agentKeys = new Set(opts.agentPubkeys);

  // How many agent posts each thread already holds. Counted over EVERY post
  // handed in, not just the candidates, so a thread that two agents have been
  // batting back and forth is recognised before another reply is added to it.
  const agentPostsInThread = new Map<number, number>();
  for (const p of posts) {
    if (p.pubkey && agentKeys.has(p.pubkey)) {
      const t = threadOf(p);
      agentPostsInThread.set(t, (agentPostsInThread.get(t) ?? 0) + 1);
    }
  }

  const pending: MentionablePost[] = [];
  for (const post of [...posts].sort((a, b) => a.id - b.id)) {
    if (opts.answeredPostIds.has(post.id)) continue;
    // Never answer itself. An agent that mentions its own nym while replying
    // would otherwise re-trigger on its own output — a one-agent loop, which is
    // the same bug as the two-agent one but harder to notice.
    if (post.pubkey === opts.agentPubkey) continue;
    if (!mentionsAgent(post.content, opts.agentNym)) continue;

    // The hard stop. Note this is checked against the thread's CURRENT count,
    // and the count includes replies this agent is about to add below.
    const thread = threadOf(post);
    const used = agentPostsInThread.get(thread) ?? 0;
    if (used >= opts.maxAgentPostsPerThread) continue;

    pending.push(post);
    agentPostsInThread.set(thread, used + 1);
    if (pending.length >= opts.maxPerTick) break;
  }
  return pending;
}
