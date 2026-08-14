"use client";

/**
 * The vision block at the top of the feed (ORIGIN mode, or LIVE once post #1 is
 * reached).
 *
 * ⚠ TENSE IS THE WHOLE SAFETY MECHANISM HERE. This page is read by people
 * deciding whether to put work, and eventually money, into OpenBooks. Everything
 * in the PRESENT tense is shipped and verifiable today; everything else sits
 * under "What we're building" or the status box and is explicitly marked as not
 * built. Describing an unbuilt thing as if it exists would be a mis-sale, not
 * enthusiasm.
 *
 * ⚠ THE LINE TO HOLD IS **TOKEN vs MARKET**, NOT "no token". Posting IS the mint
 * (TOKENS.md, "A post IS a token"): a user creates and owns a token when they
 * post, that is live today, and the wallet shows it. An earlier version of this
 * file said "there is no token — nothing is buyable, earnable, holdable or
 * tradable", which the owner rejected as contradicting the model the product is
 * built on. What does NOT exist is the MARKET: paid posting, depleting supply,
 * and any way to trade. Hedge the market; never hedge the token.
 *
 * Specifically, and these are the easy mistakes to make:
 *  - Posting is FREE today. Paid posting is the model, not the current state.
 *  - Tokens are real and owned; there is nowhere to SELL them and no date for one.
 *  - Citation-minting (a 1-of-1 becoming a 1-of-2 when invoked) is NOT built, and
 *    is blocked on an unanswered question — see TOKENS.md. Do not describe it here.
 *  - No "get in early" framing anywhere. The same rule the agent prompt
 *    enforces in conversation applies harder on a page that cannot be
 *    questioned back.
 *
 * When the market lands, move it out of "What we're building" and update the
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
          A board for ideas where the record of who wrote what is public, permanent, and belongs to
          the person who wrote it. Not a startup, not a pitch deck &mdash; a different arrangement,
          where the people who build something hold a piece of it.
        </p>

        {/* Pull quote 1 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Post an idea. It&rsquo;s timestamped. Immutable. Yours.
        </p>

        {/* ── How it works — EVERY LINE HERE IS LIVE TODAY. Anything not shipped
               belongs in the status box below, marked as such. ──────────────── */}
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
          written to the BSV blockchain with its signature &mdash; timestamped, permanent, and
          checkable by anyone, including against us. That&rsquo;s the part that makes &ldquo;who was
          first&rdquo; a fact instead of an argument.
        </p>
        <p>
          <span className="font-semibold text-white">Posting mints you a token.</span> One post, one
          token, held in your name from the moment you write it. Your wallet shows what you hold in
          every thread you&rsquo;ve posted in, and what share of that thread it is. Nobody grants it
          and there is nothing to apply for &mdash; you get it by writing something.
        </p>
        <p>
          <span className="font-semibold text-white">A thread can be named.</span> Write a{" "}
          <span className="text-amber-400">$Ticker</span> and you claim it: the thread gets an
          address anyone can link to, and your token gets a name instead of a transaction id. Names
          are unique and first come, first served.
        </p>
        <p>
          <span className="font-semibold text-white">Anyone can boost a post.</span> A boost is a
          payment, and it splits in a single transaction: to contributors, to the post&rsquo;s
          creator, and a cut that keeps the thing running. No balances are held, no IOUs are issued,
          nothing is owed to you later. Every satoshi leaves in the same transaction it arrived in,
          and you can read it on-chain.
        </p>

        {/* Pull quote 2 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-amber-300 font-medium italic leading-snug">
          Your contribution doesn&rsquo;t have to be finished. It just has to be real.
        </p>

        <p>
          An idea posted here isn&rsquo;t a comment that scrolls away. It&rsquo;s the first page of
          something others can build on, argue with, and carry further &mdash; and you keep a piece
          of it while they do. Working with strangers needs no company, no contract, and nobody
          taking it on trust, because the record is public and the arithmetic is too.
        </p>

        {/* ── The fork ──────────────────────────────────────────────────────── */}
        <p className="pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          Why we forked
        </p>
        <p>
          OpenBooks is a fork of <span className="text-zinc-300">OpenCook</span>, which built the
          board, the on-chain record and the payment split, and built them well. The split works.
          The payments are real. We didn&rsquo;t fork because something was broken.
        </p>
        <p>
          We forked over one thing:{" "}
          <span className="font-semibold text-white">
            being paid for a contribution isn&rsquo;t the same as owning a piece of it.
          </span>{" "}
          There, you&rsquo;re paid when a post is boosted, and then it&rsquo;s over. A thread you
          helped start can run for years without you holding any part of what it becomes.
        </p>
        <p>
          Here, it&rsquo;s yours from the moment you post. That much is live: writing mints you a
          token, and it stays yours whether or not anyone ever boosts you.
        </p>
        <p>
          <span className="text-zinc-300">Where it goes next</span> is that a thread carries a
          finite supply. You&rsquo;d pay to post, so a token is bought rather than handed out; as a
          thread fills the tokens get scarcer and cost more; and when the supply is gone the thread
          closes &mdash; fixed forever, held by the people who actually built it. The conversation
          carries on in a new thread that pays a share back to the one it grew out of.
        </p>
        <p className="text-zinc-400">
          That last part is a real trade, not a free upgrade. Posting is free today and
          wouldn&rsquo;t be under that model, and a place where ideas cost money to join is a
          different thing from one where they don&rsquo;t. We think owning what you helped build is
          worth it. We&rsquo;d rather say so plainly than have you find it in the small print.
        </p>

        {/* Pull quote 3 */}
        <p className="my-5 pl-3 border-l border-amber-500/50 text-base text-white font-semibold italic leading-snug">
          This is what happens when the builders keep what they build.
        </p>

        {/* ⚠ Honest status. See the file header before editing or removing.
               The line is TOKEN vs MARKET — hedge the market, never the token. */}
        <p className="rounded-md border border-zinc-700/70 bg-zinc-950/40 px-3 py-2.5 text-[13px] text-zinc-400 leading-relaxed">
          <span className="font-semibold text-zinc-300">Where this is right now.</span> Live today:
          posting, posts anchored on-chain, threaded replies, <span>$Ticker</span> names with their
          own addresses, photos and video, boosts that split payment straight to contributors in one
          transaction, and{" "}
          <span className="text-zinc-300">
            one token to you for every post you make &mdash; yours, counted, visible in your wallet
          </span>
          . Not built yet: <span className="text-zinc-300">the market</span> &mdash; paid posting,
          the depleting supply, thread closure, and any way to trade what you hold. So your tokens
          are real and they are yours; there is nowhere to sell them, and no date for one. The open
          questions are written up in the open, and this page will keep saying so until it
          isn&rsquo;t.
        </p>

        {/* Closing line — handwritten style.
            Replaces an inherited founder quote ("You will not succeed as a solo
            developer. Not anymore.") that was cut deliberately: it diagnosed the
            wrong problem. Working alone is not the thing that fails — people ship
            alone constantly. What failed was CONTRIBUTING to someone else's thing,
            which meant doing it for free or doing it for an owner.
            Then updated again: it said "getting counted for the part you did",
            which is the OpenCook thesis — attribution. Being counted is not the
            fork's argument. KEEPING a piece of it is. */}
        <p className="my-6 pl-3 border-l border-amber-500/50 font-[family-name:var(--font-caveat)] text-lg sm:text-xl text-amber-200 leading-snug">
          Building alone was never the problem. Keeping a piece of what you built was.
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
