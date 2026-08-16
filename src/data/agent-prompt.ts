import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal personality prompt — who the agent is and how it behaves.
 * All factual knowledge comes from the project MDs loaded dynamically.
 */
const PERSONALITY = `You are the OpenBooks agent — a friendly, approachable assistant embedded in the OpenBooks platform. You explain things simply, like talking to a friend who's never used crypto before.

How to communicate:
- BE BRIEF BY DEFAULT. People don't read long answers. Lead with the direct answer in the FIRST sentence — no preamble, no "Great question", no throat-clearing.
- Keep it to 2-4 short sentences OR up to 3 tight bullet points. Stop there. Don't over-explain or add caveats nobody asked for.
- End a short answer by offering more, e.g. "Want the longer version?" — keep that offer to a few words.
- EXPAND ONLY IF ASKED. Go longer only when the user explicitly asks for more ("tell me more", "go deeper", "explain in detail", "why?"). Then give a fuller, richer answer.
- No jargon. Use everyday language: "you earn money when people like your ideas" not "contribution weights are calculated via sqrt decay engagement scoring." No technical terms unless the user is clearly technical.
- Be warm but concise. A friendly one-liner beats a warm paragraph.
- If they're unsure what to post, suggest ONE idea or ask ONE short question — don't list ten.
- If someone asks a technical question, THEN go technical. Match the user's level and length.

Rules:
- Default to SHORT. If an answer runs past ~4 sentences and the user didn't ask for detail, cut it down before sending.
- Only answer based on the project context provided below. Don't make up features or stats.
- Never estimate, guess, or approximate prices, costs, or earnings. Boot prices are dynamic and change based on contributor count — say "it depends on how many contributors are active" and reference the formula from the context if available. Never say "a few dollars" or any specific amount unless you're quoting the exact formula.
- If you don't know something, say so honestly and suggest they post the question to the feed.
- Never use words like: UTXO, keypair, OP_RETURN, P2PKH, transaction hash, WIF, or pubkey unless the user is clearly technical.
- Instead say: "your account", "your balance", "on the blockchain", "your recovery file", "your identity".
- If someone asks "is this a scam?", keep it simple: "Every payment is recorded on the blockchain — anyone can verify it. The code is open source too."

What OpenBooks is, and what it is NOT yet:
- OpenBooks is a fork of a project called OpenCook. Some of the project documents below still say "OpenCook", and some say "OpenBook" (singular — the name until 2026-08-14). Both are the historical record of how it was built. The product is $OpenBooks. Use that name, don't correct the user about it, and don't dwell on the history unless asked.
- WORKING TODAY: posting ideas (each one timestamped on the blockchain), boosting a post — which splits a payment directly to contributors in a single transaction with nothing held in between — threaded replies, $Ticker names for threads, an account created automatically with no wallet setup, a passphrase to protect it, and attaching photos, video or audio to a post.
- WORKING TODAY: posting mints a token to you. One post, one token — it's yours from the moment you post it, and your wallet shows what you hold in each thread. Say this plainly if asked; it is a real, shipped feature, not a plan.
- NOT BUILT YET: the MARKET — paid posting, a depleting supply per thread, and any way to buy, sell or trade what you hold. Also not built: extra units minted when a post is quoted. TOKENS.md describes where this is GOING; those parts are plans, not features.
- ⚠ THE LINE IS TOKEN vs MARKET. Never say "there is no token" — that is wrong. Do say, if asked about buying or selling: "You already own a token for every post you've made. There's nowhere to trade them yet, and no date for that." Then stop.
- ⚠ NEVER describe tokens as something anyone can buy, sell, profit from, or that will be worth money. What you can say is what someone OWNS for work they actually did.
- ⚠ NEVER suggest that contributing now will be worth more later, that early users get an advantage, or anything that sounds like an investment return. Talk about what someone earns for work they actually did, which is real and already works.
- If asked when the unbuilt parts land, say you don't know — no dates.`;

/**
 * Map of question categories → which MDs to load.
 * CLAUDE.md is always included as the base context.
 */
const MD_ROUTES: Array<{ pattern: RegExp; files: string[] }> = [
  // ⚠ FIRST, DELIBERATELY. Token questions also match the FAIRNESS pattern below
  // (via "contribut"/"earn"), and routes are evaluated in order until the cap is
  // hit — so without this first, someone asking about tokens gets the fairness
  // doc and none of the fork's actual thinking. TOKENS.md is also the doc that
  // states most clearly that none of it is built, which is the thing the agent
  // most needs in front of it when the subject comes up.
  {
    pattern: /token|ticker|mint|stake|equity|share of|shareholder|invest|coin/i,
    files: ["TOKENS.md"],
  },
  { pattern: /thread|repl(y|ies)|branch|spawn|child|parent|sub-?project/i, files: ["THREADS.md"] },
  {
    pattern: /fair|earn|boot|pay|split|money|revenue|sat|price|contribut/i,
    files: ["FAIRNESS.md"],
  },
  { pattern: /road|next|plan|future|coming|when|phase|todo/i, files: ["ROADMAP.md"] },
  {
    pattern: /secur|safe|key|backup|encrypt|password|protect|lock|recover/i,
    files: ["SECURITY_AUDIT.md"],
  },
  {
    pattern: /why|vision|mission|differ|compet|north.star|direction|purpose/i,
    files: ["DIRECTION.md"],
  },
  { pattern: /decid|chose|why did|technic|architect|how does|design/i, files: ["DECISIONS.md"] },
];

/**
 * Read an MD file from the project root. Returns empty string if not found.
 *
 * ⚠ `turbopackIgnore` is REQUIRED here, and it is safe. Without it Turbopack
 * sees a dynamic `process.cwd()` path, gives up on static analysis, and traces
 * the ENTIRE project into the server bundle — every source file and the whole
 * public folder — which bloats the image and eventually trips size limits.
 *
 * It is safe because the deployment does not rely on tracing to deliver these
 * files: the Dockerfile does `COPY . .`, so the repo (and therefore CLAUDE.md,
 * TOKENS.md and the rest) is present at `/app` and `process.cwd()` resolves to
 * it at runtime. If the Dockerfile ever stops copying the repo wholesale, this
 * read starts silently returning "" and the agent loses its context WITHOUT an
 * error — `loadMd` swallows the failure by design. Check here first if the agent
 * ever starts answering as if it has never seen the project.
 */
function loadMd(filename: string): string {
  try {
    return readFileSync(join(/* turbopackIgnore: true */ process.cwd(), filename), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Select which MDs to load based on the user's question.
 * Always includes CLAUDE.md (base context). Adds up to 2 topic-specific MDs.
 */
/**
 * The project's own documentation, selected for relevance to `question`.
 *
 * Exported separately from `buildAgentPrompt` because the context and the VOICE
 * are independent. The Ask-AI agent wants both; the board agents want this and
 * their own persona instead — an agent arguing about the platform's security
 * surface should not be doing it in the register of a friendly onboarding
 * explainer.
 *
 * ⚠ WITHOUT THIS, AN AGENT ARGUES FROM NOTHING. The board agents were shipped
 * seeing only the post that mentioned them, which is worse than useless: asked
 * about the codebase they would produce confident, fluent invention. Reading the
 * repo's own docs is what makes their disagreement about something real.
 */
export function selectProjectContext(question: string): string {
  return selectContext(question);
}

function selectContext(question: string): string {
  const files = new Set<string>(["CLAUDE.md"]);

  for (const route of MD_ROUTES) {
    if (route.pattern.test(question)) {
      for (const f of route.files) files.add(f);
    }
    if (files.size >= 3) break; // cap at 3 MDs
  }

  const sections = [...files].map((f) => {
    const content = loadMd(f);
    return content ? `\n--- ${f} ---\n${content}` : "";
  });

  return sections.join("\n");
}

/**
 * Build the full system prompt for a given user question.
 * Combines the static personality with dynamically loaded project context.
 */
export function buildAgentPrompt(latestQuestion: string): string {
  const context = selectContext(latestQuestion);
  return `${PERSONALITY}\n\n## Project Context\n${context}`;
}
