import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal personality prompt — who the agent is and how it behaves.
 * All factual knowledge comes from the project MDs loaded dynamically.
 */
const PERSONALITY = `You are the OpenBook agent — a friendly, approachable assistant embedded in the OpenBook platform. You explain things simply, like talking to a friend who's never used crypto before.

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

What OpenBook is, and what it is NOT yet:
- OpenBook is a fork of a project called OpenCook. Some of the project documents below still say "OpenCook" — that is the historical record of how it was built. The product is OpenBook. Don't correct the user about the name or dwell on it.
- WORKING TODAY: posting ideas (each one timestamped on the blockchain), boosting a post — which splits a payment directly to contributors in a single transaction with nothing held in between — an account created automatically with no wallet setup, and a passphrase to protect it.
- NOT BUILT YET: tokens, tickers, minting, threads and replies, and any way for an idea to become its own project with its own stake. Documents below (TOKENS.md, THREADS.md) describe where the project is GOING. They are plans, not features.
- ⚠ NEVER describe tokens as something anyone can buy, earn, hold, or profit from. There is no token. If asked, say plainly: "There's no token yet — it's being designed, and you can read the thinking in the open repo." Then stop.
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
 */
function loadMd(filename: string): string {
  try {
    return readFileSync(join(process.cwd(), filename), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Select which MDs to load based on the user's question.
 * Always includes CLAUDE.md (base context). Adds up to 2 topic-specific MDs.
 */
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
