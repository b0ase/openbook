"use client";

/**
 * The vision block at the top of the feed (ORIGIN mode, or LIVE once post #1 is
 * reached).
 *
 * ⚠ THE STATUS PARAGRAPH IS LOAD-BEARING — DO NOT QUIETLY DROP IT. This page is
 * read by people deciding whether to put work, and eventually money, into
 * OpenBook. Copy that describes the token layer as if it exists would be a
 * mis-sale, not just enthusiasm: TOKENS.md records it as a DIRECTION, NOT A
 * DECISION, and nothing of it is built. Everything stated in the present tense
 * here is shipped and verifiable; everything else is marked as ahead.
 *
 * When the token work lands, move it from the "next" paragraph into the body and
 * update the status line — in the same commit.
 */

interface ManifestoProps {
  onAskAgent?: () => void;
}

export function Manifesto({ onAskAgent }: ManifestoProps) {
  return (
    <div className="border-l-2 border-amber-500 bg-zinc-900/50 px-5 py-6 mb-0">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1 h-4 bg-amber-500 rounded-full" />
        <span className="text-[10px] font-semibold text-amber-500 uppercase tracking-[0.12em]">
          The Vision
        </span>
      </div>

      {/* Hook heading */}
      <h2 className="text-xl sm:text-2xl font-bold text-white leading-tight tracking-tight mb-4">
        An open book of who built what.
      </h2>

      {/* Body */}
      <div className="space-y-3 text-sm text-zinc-100 leading-relaxed">
        <p>
          Not a startup. Not a pitch deck. A different model entirely — one where the people who
          build something are the people who own it.
        </p>
        <p className="text-zinc-400">
          Here's how the old world works: your labour flows up. Value pools at the top. You get what
          they decide.
        </p>
        <p>
          Here's how this works: value flows directly to the people who created it. No intermediary,
          no approval process, no promise to pay later. One transaction, every contributor paid in
          it, on-chain and checkable by anyone.
        </p>

        {/* Pull quote 1 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Post an idea. It's timestamped. Immutable. Yours.
        </p>

        <p>
          If someone builds on it — your rough sketch, your half-formed thought, your fragment of
          something real — you get credited. Forever. Because the chain doesn't lie and it doesn't
          forget.
        </p>
        <p>
          Experts of every field, working on what they actually care about. Not what a board
          approves. What drives them.
        </p>

        {/* Pull quote 2 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Your contribution doesn't have to be finished. It just has to be real.
        </p>

        <p>
          An idea posted here isn't a comment that scrolls away. It's the first page of something
          others can build on, argue with, and carry further.
        </p>
        <p>
          And because every contribution is counted and paid automatically, working with strangers
          needs no company, no contract, and no one taking it on trust. The split is arithmetic, in
          public. That's the part that's new — not that you can't build alone, but that you can now
          build with anyone without signing your work over to them.
        </p>

        {/* Pull quote 3 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-white font-semibold italic leading-snug">
          This is what happens when the builders keep what they build.
        </p>

        {/* ⚠ Honest status. See the file header before editing or removing. */}
        <p className="rounded-md border border-zinc-700/70 bg-zinc-950/40 px-3 py-2.5 text-[13px] text-zinc-400 leading-relaxed">
          <span className="font-semibold text-zinc-300">Where this is right now.</span> Live today:
          posts anchored on-chain, and boosts that split payment straight to contributors in a
          single transaction — no balances held, no IOUs. Being built next: threads that carry their
          own stake, so a branch of an idea can hold value for the people who started it. That part
          isn't finished, and this page will keep saying so until it is.
        </p>

        {/* Closing line — handwritten style.
            Replaces an inherited founder quote ("You will not succeed as a solo
            developer. Not anymore.") that was cut deliberately: it diagnosed the
            wrong problem. Working alone is not the thing that fails — people ship
            alone constantly. What failed was CONTRIBUTING to someone else's thing,
            which meant doing it for free or doing it for an owner. Splitting
            payment by contribution fixes attribution, not some deficiency in
            working alone, and scolding the reader buried the actual point. */}
        <p className="my-6 pl-3 border-l border-amber-500/50 font-[family-name:var(--font-caveat)] text-lg sm:text-xl text-amber-200 leading-snug">
          Building alone was never the problem. Getting counted for the part you did was.
        </p>

        <p className="text-zinc-300">
          Be part of it.{" "}
          {onAskAgent ? (
            <button
              type="button"
              onClick={onAskAgent}
              className="text-amber-400 hover:text-amber-300 transition-colors underline underline-offset-2"
            >
              Chat with the agent to learn more.
            </button>
          ) : (
            <span className="text-amber-400">Chat with the agent to learn more.</span>
          )}
        </p>
      </div>
    </div>
  );
}
