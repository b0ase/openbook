"use client";

/**
 * The vision block at the top of the feed (ORIGIN mode, or LIVE once post #1 is
 * reached).
 *
 * ⚠ TENSE IS THE WHOLE SAFETY MECHANISM HERE. This page is read by people
 * deciding whether to put work, and eventually money, into OpenBook. Everything
 * in the PRESENT tense is shipped and verifiable today; everything else sits
 * under "What we're building" or the status box and is explicitly marked as not
 * built. TOKENS.md records the token layer as a DIRECTION with open questions —
 * describing it as if it exists would be a mis-sale, not enthusiasm.
 *
 * Specifically, and these are the easy mistakes to make:
 *  - Posting is FREE today. Paid posting is the model, not the current state.
 *  - There is no token. Nothing is buyable, earnable, holdable or tradable.
 *  - No "get in early" framing anywhere. The same rule the agent prompt
 *    enforces in conversation applies harder on a page that cannot be
 *    questioned back.
 *
 * When the token work lands, move it out of "What we're building" and update the
 * status box — in the same commit.
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
          A board for ideas where the record of who contributed what is public, permanent, and pays
          out automatically. Not a startup, not a pitch deck — a different arrangement, where the
          people who build something are the people who own it.
        </p>

        {/* Pull quote 1 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Post an idea. It's timestamped. Immutable. Yours.
        </p>

        {/* ── How it works — every line here is live today ─────────────────── */}
        <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          How it works
        </p>
        <p>
          <span className="font-semibold text-white">You post.</span> No signup, no wallet, no seed
          phrase. A key is generated in your browser the first time you arrive, and it signs your
          posts so authorship is provable rather than claimed.
        </p>
        <p>
          <span className="font-semibold text-white">The post goes on-chain.</span> Every post is
          written to the BSV blockchain with its signature — timestamped, permanent, and checkable
          by anyone, including against us. That's the part that makes "who was first" a fact instead
          of an argument.
        </p>
        <p>
          <span className="font-semibold text-white">Anyone can boost a post.</span> A boost is a
          payment, and it splits in a single transaction: to contributors by weight, to the post's
          creator, and a cut that keeps the thing running. No balances are held, no IOUs are issued,
          nothing is owed to you later. Every satoshi leaves in the same transaction it arrived in,
          and you can read it on-chain.
        </p>
        <p>
          <span className="font-semibold text-white">Your weight is computed, not granted.</span>{" "}
          What you've posted and what got boosted decides your share. Nobody approves it, and there
          is no application to fill in.
        </p>

        {/* Pull quote 2 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Your contribution doesn't have to be finished. It just has to be real.
        </p>

        <p>
          An idea posted here isn't a comment that scrolls away. It's the first page of something
          others can build on, argue with, and carry further. And because contributions are counted
          and paid automatically, working with strangers needs no company, no contract, and no one
          taking it on trust. The split is arithmetic, in public.
        </p>

        {/* ── The fork ──────────────────────────────────────────────────────── */}
        <p className="pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          What we're building, and why we forked
        </p>
        <p>
          OpenBook is a fork of <span className="text-zinc-300">OpenCook</span>, which built
          everything above and built it well. The split works. The payments are real. We didn't fork
          because something was broken.
        </p>
        <p>
          We forked over one thing:{" "}
          <span className="font-semibold text-white">
            getting paid for a contribution isn't the same as owning a piece of it.
          </span>{" "}
          Today you're paid when a post is boosted, and then it's over. The thread you helped start
          can run for years without you holding any part of what it becomes.
        </p>
        <p>
          So the direction here is that a thread carries its own stake. You'd pay to post, and
          receive that thread's tokens in return — a tradable receipt for having been there and
          contributed. Each thread has a finite supply, so as it fills up the tokens get scarcer and
          cost more, and when the supply is gone{" "}
          <span className="text-zinc-300">the thread closes</span> — fixed forever, held by the
          people who actually built it. The conversation carries on in a new thread that pays a
          share back to the one it grew out of.
        </p>
        <p className="text-zinc-400">
          It's a real trade, not a free upgrade. Posting is free today and wouldn't be under that
          model, and a system where ideas cost money to join is a different thing from one where
          they don't. We think owning the thing you helped build is worth it. We'd rather say that
          plainly than discover it in the small print.
        </p>

        {/* Pull quote 3 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-white font-semibold italic leading-snug">
          This is what happens when the builders keep what they build.
        </p>

        {/* ⚠ Honest status. See the file header before editing or removing. */}
        <p className="rounded-md border border-zinc-700/70 bg-zinc-950/40 px-3 py-2.5 text-[13px] text-zinc-400 leading-relaxed">
          <span className="font-semibold text-zinc-300">Where this is right now.</span> Live today:
          free posting, posts anchored on-chain, boosts that split payment straight to contributors
          in one transaction, and threaded replies. Not built:{" "}
          <span className="text-zinc-300">
            the token, the mint, paid posting, and everything about supply
          </span>{" "}
          — there is nothing to buy, hold or trade, and no date for it. It's a direction with open
          questions, written up in the open, and this page will keep saying so until it isn't.
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
