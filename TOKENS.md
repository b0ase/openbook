# Tokens

> Fork-direction document. A token layer is the primary way OpenBook intends to diverge
> from upstream OpenCook.
>
> **Status: a direction, not a decision.** Nothing here is implemented. When a design is
> chosen, the decision moves to DECISIONS.md and this file becomes the rationale trail.
>
> Related: [THREADS.md](THREADS.md) — thread structure, the prerequisite for a token tree.
>
> Last updated: 2026-08-14

## Why this document exists

Upstream OpenCook states plainly that it has no token (DIRECTION.md, *"Yeah, we pump. We
pump real value"*). That is a deliberate position, well-argued, and backed by a competitive
table showing how token-based predecessors failed — Steemit's whale-dominated voting,
SourceCred's synthetic Grain, Friend.tech's speculation collapse.

OpenBook takes the opposite side of that bet. This document sets out where a token
attaches, what the chain can and cannot enforce, and which parts of the upstream analysis
survive scrutiny and should be respected rather than waved away.

## The shape

A root token `$OpenBook`. Anyone starts a thread, marks it with a symbol, and mints — so
tokens branch from threads, forming a tree. A parent takes a share of each child. Minting
is paid for, and the payer receives the tokens.

This is DIRECTION.md's "Recursive Model" (*"any post can become its own project"*)
instantiated in-app with tokens, rather than by forking a repo and deploying an instance.

**This matters: everything happens inside one deployment.** No GitHub API, no provisioning,
no multi-tenancy. It also sidesteps an enforceability wall — you cannot charge for forking
a public GitHub repo (their ToS grants fork rights to everyone; bit-sign's `fork-terms.ts`
documents this in detail). In-app minting has no such problem, because the platform
controls issuance.

## The mint gesture — `$ticker` in the compose box

Proposed 2026-08-14. The interaction, not the economics: you type your idea in the ordinary
compose box, include a `$ticker` somewhere in it, and the **send button becomes a mint
button**. Pressing it starts the thread and mints its token in one act.

**Why this is the right gesture and not a gimmick.** It removes the entire "create a token"
flow — no separate screen, no form, no mode to enter. The user does not decide to mint and
then write; they write, and the act of naming a ticker *is* the decision. That is as close
as this gets to DIRECTION.md's 2-click onboarding, applied to the founding act rather than
to posting. It also makes the cost legible at exactly the moment it is incurred: the button
changing is the disclosure.

**What it commits us to.**

- **The ticker is parsed from post content**, so the content and the token are not separable
  — which is correct here (the post IS the token's charter) but means the parse rule is
  consensus-critical and belongs on-chain in the post record, not only in the UI.
- **The button must state the price.** A send button that silently spends is the one thing
  this cannot be. Mint is paid (see *Supply and dilution* — payment is what gives issuance a
  cost basis), so the button says what it costs before it is pressed.
- **Posting is paid — decided 2026-08-14, reaffirmed.** An earlier draft of this section had
  the ticker gate the cost, keeping ordinary posting free. That is no longer the model: every
  post is a purchase (see *Supply and dilution*). The `$ticker` gesture now marks the act
  that **opens** a thread and its supply, not the act that makes a post cost money. The
  consequence is accepted and named under *What paid posting costs* below.
- **A failed mint must not silently become an ordinary post**, and an ordinary post must
  never accidentally mint. `$` appears in normal prose ("$50", "$OpenBook" as a reference).
  The parse rule needs a deliberate shape, and the ambiguous cases resolve toward NOT
  minting.

### The ticker is a hotlink, and claiming is the genesis mint

Refined 2026-08-14 (owner, posting publicly as the design was worked out):

> *"People 'claim' new token ideas — they get the genesis token — just by adding a new
> `$tokenidea` inline. The `$tokenidea` is a hotlink to their new thread. Click on it and you
> can follow their idea."*

Three things that adds to the gesture above:

- **A `$ticker` in post text renders as a LINK to that ticker's thread.** This is the part
  that makes the tree navigable instead of merely existing in the schema — a thread can point
  at a child by naming it mid-sentence, and readers follow it like any other link. It is also
  the one piece of the whole token design that is **buildable today**: threading shipped, so
  a `$ticker` could resolve to a `root_id` and open the thread view right now, with no mint,
  no fee and no covenant behind it.
- **The claimer receives the genesis token.** Naming a ticker nobody has claimed is itself the
  first mint, and it goes to the person who named it. That is what makes claiming a founding
  act rather than a reservation, and it is why the gesture has to be paid — a free claim is a
  free option on every word in the language.
- **"Proof of writing."** The owner's phrase for the issuance rule, and a good one: tokens are
  awarded for writing, cheaply at first and more expensively as supply dries up. It names what
  the payment is evidence OF, which is the thing a reader needs to understand in one line.

**BUILT 2026-08-14 (the non-token half).** The hotlink and the registry ship without any
token machinery: a `tickers` table (`symbol` PRIMARY KEY = first claim wins), registration in
`createPost`, `resolveTickers`, and `$Ticker` rendered as a link that opens the thread. What
is NOT built remains everything monetary — no mint, no fee, no supply, no covenant. Claiming
is currently free, which is the temporary state, not the model.

**Resolved by building it:** ticker uniqueness. BSV-21 identity is the deploy
`txid_vout`, so `sym` is deliberately NOT globally unique (see *BSV-20 vs BSV-21*) — which
removes squatting but means two threads can both call themselves `$NewIdea`. If a `$ticker` in
post text is a hotlink, it must resolve to exactly one thread, so the APP needs a first-claim
registry even though the PROTOCOL does not. **First claim wins, enforced by the PRIMARY KEY** rather than by application logic — so there
is no read-then-write race and no check to forget. Symbols are stored canonical (uppercase),
which closes the visually-identical-second-claim vector.

**Not built.** Nothing about minting exists yet — no ticker registry, no fee, no covenant.
Building the button before the thing it triggers would be a button that lies.

### What paid posting costs

Decided, not overlooked. Recorded once so it is not rediscovered as a surprise.

DIRECTION.md's onboarding claim — *"no wallet downloads, no seed phrases, no 'buy crypto
first'"*, targeting ~15% conversion against an industry ~0.3% — rests on posting being free.
**Paid posting ends that claim as written.** A first-time user must have funded their
address before their first post, which is the friction the 2-click onboarding was built to
remove.

The trade being accepted: a smaller number of users who are actually buying something, over
a larger number who are posting into a system where their contribution is counted but not
owned. That is a legitimate bet and it is the fork's whole thesis, but it is a bet.

**Follow-through required:** DIRECTION.md still states the free-posting claim and must be
updated when this ships — a stale conversion claim in the direction document is exactly the
kind of thing that gets repeated into a pitch.

## The attachment seam

`split.ts` does not know where weights come from:

```ts
calculateSplit(bootFeeSats, creatorPubkey, creatorAddress, platformAddress, weights: ContributorWeight[])
```

Everything about *how* weight is earned lives in `weights.ts`, now behind a `WeightSource`
interface (`getWeightSource` / `setWeightSource`). A token-backed source replaces its return
value and touches nothing downstream. `calculate` returns
`ContributorWeight[] | Promise<ContributorWeight[]>` — async, because every realistic token
source reads a network.

**The divergence is one function wide, not a rewrite.**

## Custody: why a fixed supply cannot work

The original version of this document proposed minting a fixed supply and allocating from
an unissued reserve, borrowing bit-sign's `room-allocations.ts` (*"the unallocated reserve
is precisely the authorised-but-unissued capital future parties are admitted from"*).

**That does not transplant, and the reason is fundamental.** bit-sign's reserve works
because `share_bps` is a *database number* — unissued supply is simply bps not yet assigned
to a row, so nobody custodies it because it does not exist as an asset yet.

In a UTXO model there is no unallocated state. **Tokens live in outputs at addresses.** A
supply minted at genesis must sit somewhere, and whoever holds that key custodies it.
"Reserve" is not a protocol state; it is an address someone controls.

The same objection kills the obvious fix. If a parent "owns 50% of a child," those tokens
need a recipient — and a token is not a person, so any address receiving on the parent's
behalf is a custodian.

### The trilemma, and the way out

| | non-custodial | no IOUs | cheap mints |
|---|---|---|---|
| Treasury address holds the share | ✗ | ✓ | ✓ |
| Pro-rata push to every parent holder | ✓ | ✓ | ✗ |
| Claim ledger — entitlement recorded, holders mint on demand | ✓ | ✗ | ✓ |
| **Covenant — supply held by a script, not a key** | **✓** | **✓** | **✓** |

The covenant resolves it rather than picking two, and it is not theoretical — see below.

## What the chain actually enforces

Two production patterns, both read at source rather than assumed.

### POW-20 — a reserve with no custodian

`HashToMintBsv20` (extending `BSV20V2` from `scrypt-ord`) is a deployed BSV-21 token whose
**unissued supply lives in a contract UTXO rather than at anybody's address.** Each mint
transaction produces:

```
Output 0  [transfer inscription: amt = remaining]  [contract script, supply -= reward]
Output 1  [transfer inscription: amt = reward]     [P2PKH → recipient]
Output 2  change
```

and the contract enforces all three via `hash256(outputs) === this.ctx.hashOutputs`. The
spender cannot alter amounts or omit the continuation.

This is the reserve-without-a-custodian: real tokens, in a real UTXO, held by a script
rather than a key. Issuance is incremental, to arbitrary addresses.

Sources: `danwag06/htm-contract`, `b-open-io/pow20-runar`, `b-open-io/pow20-miner`.

### OrdLock — payment enforced by script

From `@1sat/templates` (`dist/ordlock/ordlock.js`), read directly. Two spend branches:

- **cancel** — requires the seller's signature.
- **purchase** — **no signature at all.** The unlocking script pushes
  `buildOutput(outputs[0])`, the concatenated `outputs[2..]`, the BIP-143 preimage
  (`SIGHASH_ALL | ANYONECANPAY | FORKID`), then `OP_0` as the branch selector. The contract
  rebuilds `hash256(output0 ‖ storedPayout ‖ trailingOutputs)` and compares it to the
  preimage's `hashOutputs`.

**Output 1 is never pushed by the spender.** It is a serialized output blob
(`satoshis ‖ varint ‖ script`) stored *inside the locking script*. That is why payment
cannot be altered: the contract supplies its own bytes at that position.

### Pay-to-mint is these two composed

BSV-21 defines *accounting* (`deploy+mint`, `transfer` inscriptions), not a mint mechanism —
the mechanism lives in the locking script. So a pay-to-mint contract is POW-20's structure
with OrdLock's predicate: supply in a contract UTXO, released when the spending transaction
contains the required payment output.

**It is simpler than POW-20**, because a payment output is natively verifiable — no hash
puzzle, no difficulty schedule. And it means the mint price needs **no oracle**: *"did this
transaction pay X to Y"* is answerable on-chain.

This is why paid minting matters beyond revenue. **The payment is the proof of
contribution.** Nothing has to attest that someone earned tokens; they bought them, and the
script checked.

## The hard limit — enforced splits are snapshots

An earlier draft claimed the fairness split could become something the script refuses to
mint without. **Reading the source shows that is only half true.**

The payouts a covenant enforces are **literal bytes in the locking script**. A contract can
enforce *"pay these addresses these amounts."* It cannot enforce *"pay according to current
contribution weights,"* because it cannot compute weights — it cannot read the posts table.

So an on-chain enforced split is a **snapshot**, refreshed by re-locking. Each mint already
re-locks the contract (output 0 is the continuation), so the snapshot *can* be updated per
mint — but whoever builds that transaction chooses the new payout list, and constraining
*that* choice needs an attestation.

**Net: the oracle is relocated, not eliminated.**

| what | enforceable on-chain? |
|---|---|
| Mint price paid | ✓ no oracle |
| Payment to a fixed recipient set | ✓ no oracle |
| Payment split by *current* contribution weights | ✗ needs an attested continuation |

Cost note: each stored payout is ~34 bytes (8-byte satoshis + varint + 25-byte P2PKH), so a
50-recipient enforced split carries ~1.7 KB of payouts in the locking script — paid twice,
once in the script and once in the real outputs.

### An attester is not a custodian

Where an attestation is needed, state the trust assumption precisely. A key that authorises
a mint **cannot redirect the supply to itself**, because the covenant constrains the
outputs. If it leaks, an attacker can mint to themselves — bad — but cannot drain a
reserve, because no address holds one.

That is a materially weaker assumption than custody. Say that, rather than "trustless."

**Longer term this may close entirely.** Posts already carry ECDSA signatures and land in
OP_RETURN, so contribution is in principle provable on-chain. A contract that verifies it
is much harder, but the ingredients exist.

## Supply and dilution — pay to post, on a depleting per-thread supply

**Settled 2026-08-14. This SUPERSEDES the uncapped mint-on-allocation position recorded
below, which is kept because the reasoning that replaced it matters.**

The model is one move: **you pay to post, and the tokens you get back are a tradable
receipt.** There is no separate mint action, no allocation formula, no scoring step. Text is
the unit of purchase — a longer post costs more and returns more tokens — and each thread
has its own **depleting supply**.

That last part is what makes it a game rather than a fee. As a thread's supply depletes the
price per token rises, so **users pay more and more to post less and less text.** Early in a
thread, tokens are cheap and posts can be long; late in a thread they are expensive and
posts are necessarily short.

**Why this is the right shape.**

- **One sentence explains it.** "You pay to post, you get tokens." Anything requiring a
  formula to justify what someone received is a worse product, whatever its properties.
- **The payment IS the proof of contribution** — see *Pay-to-mint is these two composed*.
  Nothing has to attest that someone earned tokens; they bought them, and the script checked.
- **Spam becomes self-pricing.** Free posting is the *free-post weight-farming* vector logged
  as SECURITY_AUDIT **L8**. Volume now costs money, at a price that rises the more of it
  there is.
- **The rush is the mechanism, not a side effect.** Nobody knows what a thread will become;
  all anyone knows is what its token is *called*. Buying early into an unproven name is the
  risk being priced, and the curve is what pays for taking it.
- **Threads get terser as they mature.** An emergent property worth naming: rising price per
  byte means signal density rises over a thread's life. Late posts are expensive, so they
  are short and deliberate.

### Why a per-thread cap is now possible — and was not before

*Custody: why a fixed supply cannot work* (above) still stands **as written**, and this does
not contradict it. That section rules out a supply **minted to an address**: those tokens sit
somewhere, and whoever holds the key custodies them.

A depleting supply held **in a covenant** is a different construction. `HashToMintBsv20`
already does exactly this — `supply -= reward` carried in the contract UTXO on every mint,
with `hash256(outputs)` forcing the continuation. The unissued remainder is real tokens in a
real UTXO held **by a script rather than a key**, which is the row the trilemma table already
marked as the resolution. So the cap buys scarcity without buying a treasury.

**The distinction to preserve:** a cap enforced by a covenant is fine; a cap enforced by
someone holding the unissued supply is the thing that cannot work. Do not let a future
"simpler" implementation quietly move the reserve to an address.

### Superseded: uncapped mint-on-allocation

The previous position, kept for the reasoning:

> Mint-on-allocation means **uncapped supply**. It needs an anchor — free minting is free
> money and worth nothing. Continuous dilution replaces the decay curve: uncapped
> mint-on-contribution *is* continuous dilution, so contributor #500 is not shut out by a
> closed cap table, and no 30-day half-life is needed to prevent accumulation.

What survives: the anchor argument, which the new model satisfies more directly (the price
is the anchor, and it rises). What does not: "contributor #500 is not shut out" is now
**deliberately false** — later contributors get less, and paying more for it is the point.
That is a real cost, taken knowingly, and it is what open question 7 was asking about.

**The parent's share must be per-mint, not one-off.** A one-time parent allocation dilutes
to nothing as the child grows. So every child mint also produces the parent's output,
enforced by the covenant. Note the arithmetic — a 50% parent share means the contributor
receives half of what is minted on their behalf, and the child's supply depletes at twice
the contribution rate.

## Closure — a thread ends when its supply is minted out

**Settled 2026-08-14.** When a thread's supply is exhausted it closes: no further posts. The
thread stays readable forever — the posts are already permanent and on-chain — but nothing
more can be added to it.

**Why this is the right answer and not just the tidy one.**

- **It is the only reading that keeps the model honest.** If posting continued after
  exhaustion, posts would stop being purchases and the "one move" would have two modes. If
  the supply were merely "large enough that it never happens", the scarcity driving the whole
  curve would be theoretical, and theoretical scarcity prices like theoretical scarcity.
- **The token becomes genuinely fixed-supply at close.** This is where the deflationary
  intuition that started this discussion actually arrives — not at deploy, but at sell-out.
  A closed thread's token can never be diluted again, and its holders are exactly the people
  who were there.
- **Closure feeds the tree.** The natural continuation of a closed thread is a **child**
  thread, which mints its own token and gives the parent a share. Closure is not death, it
  is branching pressure — which is precisely the Recursive Model this fork exists to
  instantiate, arrived at by economics rather than by asking users to please start
  sub-projects.

### What closure puts at risk

- **Supply size becomes the most important number in the system.** It is now a thread's
  lifespan. Too small and good threads die young; too large and the curve never bites. This
  is a single parameter with no obvious right value and it should be treated as the tuning
  problem it is, not a constant someone picks once.
- **A thread can be bought closed.** Anyone who wants a discussion stopped can exhaust its
  remaining supply and end it. It is *expensive* griefing — the attacker pays the top of the
  curve, the most costly tokens in the thread — and they are left holding a large share of
  something they just killed, so it is irrational for profit. But it is entirely rational for
  silencing, and this project's stated position is free speech. **This is the one place
  closure and the ethos collide, and it needs a rule before mainnet** — a per-identity share
  cap, a rate limit as supply nears zero, or an accepted answer for why neither is needed.
- **The UI has to say why.** A compose box that silently refuses is the worst version. A
  closed thread must state that it is minted out, and point at starting a child.

## BSV-20 vs BSV-21

| | BSV-20 | BSV-21 |
|---|---|---|
| Identity | `tick`, 1–4 chars, globally unique | `id` = deploy `txid_vout` |
| Deploy | `deploy` then separate public `mint` ops | `deploy+mint`, atomic |
| Supply | fixed at deploy, open mint up to `max` | contract controlled |
| Transfer rules | none | programmable via covenant |

**BSV-21**, for two reasons. Covenants are the whole design. And its `id`-based identity
means `sym` is **not unique** — so a tree of thousands of tokens has no global namespace to
squat, which removes the ticker-squatting problem earlier drafts worried about.

The inverse risk replaces it: two tokens may share a symbol, so **the UI must disambiguate
by `id` or impersonation becomes the attack.**

## Risks and honest counter-arguments

Reasons upstream may be right. Not dismissed.

- **Securities exposure, and this design increases it.** Mint, allocate, and have parents
  hold a share of children, and you have a holding structure issuing tokens at every level
  of a tree. bit-sign has the machinery for this (`investor-self-cert`,
  `offering-attestation`, `subscription-rights`, `sanctions-field`, `platform-neutrality`);
  OpenBook has none. **Lawyer time before mainnet, not after.**
- **Declare what the token is a claim on.** bit-sign's `token-claim.ts`: *"A REPO IS NOT A
  COMPANY, AND ONE INSTRUMENT FOR BOTH IS A MIS-SELLING WAITING TO HAPPEN."* A thread token
  is a repo-style token. `undeclared` is an honest default; guessing on the holder's behalf
  is the mis-sale.
- **Structurally this is a launchpad.** Anyone mints a token on an idea, tokens branch,
  early holders benefit from later activity. DIRECTION.md's own table names the failure
  mode: *"Friend.tech/DeSo — pure speculation, no intrinsic value, bubbles pop."* The single
  thing separating the two is whether the token is a claim on real boot revenue.
- **The root accrues a lot.** `$OpenBook` takes a share of every first-level thread token.
  Indirect claims decay with depth (25% at L2, 12.5% at L3), but L1 concentration is the
  dominant economic fact of the design, and the operator holds the root. Calling that
  "agentic fairness" without saying so is the mis-sale above, one level up.
- **sCrypt contract work on the money path.** `hash256(outputs)` covenants need OP_PUSH_TX /
  BIP-143 preimage handling. Well-trodden on BSV, but not a weekend, and mistakes are
  unrecoverable.
- **Pay-to-post ends zero-friction onboarding.** ~~Keep them separate.~~ **SUPERSEDED
  2026-08-14 — paid posting is now the model** (see *Supply and dilution*). The risk is
  unchanged and real; what changed is that it is now a chosen cost rather than a thing to
  avoid. Quantified under *What paid posting costs*.

## The unissued claim

Worth recording, because it frames what "adding a token" means here.

| Party | Claim | Decays? |
|---|---|---|
| Contributors | 80% pool, by weight | Yes — 30-day half-life |
| Boosted creator | 15% bonus, per event | N/A — one-shot |
| Platform | 5% of every boot, in perpetuity | **No** |

The platform cut is a non-decaying, non-dilutable, perpetual claim held at a single address.
Structurally that is a founder's allocation with no vesting — never named, issued, or made
transferable.

Not an accusation of self-dealing: the same operator excluded all 1,908 backdated genesis
posts from the pool via `launchTs`, a costly choice made against their own interest. More
likely the platform cut was modelled as "server costs" and never as a claim.

But it means the honest framing of this fork is **not** "adding a token to a token-free
system." It is: *a permanent claim already exists and exactly one party holds it; the
question is whether others get one too.*

## Media tickers and transclusion (proposed 2026-08-14)

Post an image, video or track and you are prompted to give it a ticker. Anyone can then
**invoke** `$Thatticker` in their own post and the media is embedded there.

**This is what gives a ticker a FUNCTION rather than a label.** Today `$Test` names a thread;
under this it also becomes an ADDRESS for a thing, and invoking it transcludes that thing.

**It also resolves the "should everything be tokenised" tension.** Media is discrete and
RE-USABLE — an image or a track gets referenced repeatedly, while a text comment is read once
in place. Naming earns its cost exactly where re-use happens. So "a token per post" is wrong
and "a token per referenceable thing" is right.

**It needs no new concepts.** A media post is already a thread root, so naming it makes it a
thread AND an address, and `resolveTickers` already returns that root. Invoking a ticker whose
thread root carries media can render that media inline — an extension of what exists, not a
second system.

### What has to be got right

- **Attribution is not optional.** An embed must carry a visible "from `$Ticker`" linking
  back. Without it, invoking is appropriation with extra steps.
- **Naming is consent to be quoted.** Once `$MyTrack` exists anyone can place it in a post its
  author would hate. That is the same bargain a public URL already makes, but it should be
  understood AT NAMING TIME — which is a job for the prompt, not the small print.
- **The prompt must not become a nag.** Asking on every media post trains people to dismiss
  it. Surface it only when a post is media-only with no ticker, and make it one tap.
- **Bandwidth.** Transcluded media appears in many posts; `preload="none"` and lazy loading
  (already in `MediaEmbed`) are what stop that becoming a bill for whoever hosts the file.

### The open question this creates

If invoking embeds, invocation becomes a genuine usage signal — which is precisely
DIRECTION.md's music example, *"artists should own their distribution… every listen splits
revenue."* **Should invoking pay the media's owner?**

Tempting, and the right shape, but it walks back into the trap in open question 9: an
invocation must never be both free and valuable, or the inflation problem returns. If it pays,
it must be because the INVOKING POST is paid for (pay-to-post) with a slice routed to the
owner — never because a mention conjures value from nothing. **Not decided.**

## Boosting = tokenising someone ELSE's post (proposed 2026-08-14)

Let a reader pay to give another user's post a ticker. Call the act **boosting**, replace the
Bootboard with a **Boost Board**, and retire "boot" as product language.

**It fixes a real defect, not just naming.** Today a ticker is claimed by writing `$X` in your
OWN post, so only an author can name their own work — and authors do not name their own best
work; readers do. Naming rights currently sit with the wrong party. Boosting moves recognition
to the people who recognise.

**It also gives boosting something that lasts.** A boost is currently a payment that splits and
then a spotlight that expires; nothing persists. Under this it MINTS — a permanent, citable,
invokable name for that post, which composes directly with *Media tickers and transclusion*
above: once a killer text post has a ticker, it can be quoted by invoking it.

### Who receives the tokens — WITHDRAWN, then answered differently

> **The suggestion below is withdrawn (2026-08-14).** It proposed mirroring the sat split
> (80% pool / 15% creator / 5% platform) for token allocation. That is wrong, and the owner
> caught it: the sat split governs a REVENUE event that lands once and is gone, and the weights
> behind it **decay on a 30-day half-life**. Equity must be durable. Wiring decaying
> revenue logic into a token would reproduce the exact flaw this fork exists to fix, one layer
> up. Kept visible rather than deleted, because the reasoning that killed it is the useful part.

**The answer instead: ONE TOKEN PER CONTRIBUTION.** Tokenise a post and you own one unit. Anyone
else may tokenise the SAME post under a DIFFERENT ticker and own one unit of theirs. The ticker
opens a thread, and every subsequent contribution to it mints one more unit to that
contributor. Equity spreads evenly as the thing is built.

**Why this beats any formula:**
- **100% of a thing nobody else holds is worth nothing.** No market, no network, nobody with a
  reason to care. A hundred holders is a hundred people with a stake in it mattering.
  Distribution is not a dilution cost; it is where the value comes from.
- **It fits in one sentence** — "you posted, you own one." No weights, no sqrt, no decay,
  nothing to reverse-engineer or argue about.
- **Supply becomes emergent and honest**: the supply IS the record of participation.
- **Multiple tickers on one post is safe.** Each TICKER still resolves to exactly one thread;
  it is one POST seeding several named conversations. The uniqueness invariant holds.

**Reconciling it with closure (the collision to be aware of).** *Supply and dilution* settles
that a thread has a FINITE, depleting supply and CLOSES when minted out; "one token per
comment, forever" is uncapped and flat. They reconcile cleanly: **a finite supply of N, one unit
per paid post, means a thread holds exactly N contributions and is then full.** Closure stops
being an abstraction and becomes legible — *"40 of 100 places left."*

**The residual objection, and its answer.** One-per-contribution equates PARTICIPATION with
CONTRIBUTION — a hundred people saying "agreed" own as much as a hundred doing work, which is
precisely why `weights.ts` exists. The model's own answer is pay-to-post: worthless comments
cost real money, so price does the filtering a formula otherwise would. That is a better answer
than weighting, **but it makes the COST PER POST — not the allocation rule — the parameter that
governs quality.** Set it too low and the flat allocation is farmed.

### Superseded: reuse the split that already exists

The obvious reading of *"the payer receives the tokens"* gives them all to the booster, which
means paying to own a token named after someone else's work. That is appropriation with a
price tag.

**The sat split already solves this exact problem: 80% pool / 15% creator / 5% platform.** Make
the TOKEN allocation mirror the SAT allocation. The creator holds a share of the token named
for their work, the booster holds a share for having spotted it early, and no new economic
policy is invented — `split.ts` and FAIRNESS.md have already been written, tested and argued
over. **Strongly recommended over designing a second, parallel formula.**

### "Boost" over "boot", and what must NOT be renamed

Better motivated than the Bootboard → Bookboard idea (rejected: "boot" was the verb and "book"
was not). "Boost" IS the verb, it is what the action does, and **the database already says so**
— the column is `boosted_by`.

Rename the PRODUCT LANGUAGE only. `boot_split` is written **on-chain and is immutable**, and
readers select a stream by `(app, type)` — renaming the type forks the record stream in half
for nothing. Internal column names likewise cost nothing to leave alone. UI language is not
permanent; on-chain identifiers are.

### The rule this still needs

**Naming someone's post is not a neutral act.** For a killer post it is flattering; for someone
who does not want their words tokenised it is not, and first-claim-wins means they cannot undo
it. Options, none chosen: the author can decline or retire the ticker; the author must hold a
share (which the split above gives them anyway); or naming is simply accepted as the price of
posting in public. **Decide before boosting can mint.**

## Is a domain a token? (asked 2026-08-14)

The intuition: a domain and a ticker are both unique names in a namespace, claimed
first-come, transferable, and valuable because they are memorable. That much is real. The
proposal it led to — `openbooks.space` as a place where users launch their own openbooks,
each on its own subdomain — is **not** recommended, for three reasons in increasing order of
weight.

**A domain is rented, not owned.** Its uniqueness is enforced by ICANN and a registry billing
annually, and it can be taken back. If the domain IS the token, the ownership layer sits on
rented land — which is the opposite of the argument this fork exists to make.

**Per-idea deployments were already traded away, on purpose.** See *The shape*: everything
happens inside ONE deployment, no provisioning, no multi-tenancy, and the platform controls
issuance rather than trying to charge for something anyone may fork. "Users launch their own
openbooks" is the thing that was given up, and what replaced it is already built — **a thread
with a ticker IS someone's own openbook**: its own page, its own URL, its own supply, its own
children.

**Subdomains would strand every user's identity, and this is decisive.** The WIF lives in
`localStorage`, which is scoped PER ORIGIN. `$test.openbooks.space` and `openbooks.space` are
different origins, so clicking from one to the other delivers the user as a brand-new
anonymous person — no name, no history, no funds — and silently generates a second key they
might then deposit against. Cookie bridges and `postMessage` can paper over it, at the cost
of real complexity welded onto the most safety-critical path in the app, to buy a difference
that is purely cosmetic.

**So: paths, not subdomains.** `openbooks.space/$test/$branch` already reads as a token
address, keeps one origin and one identity, and preserves real client IPs for the per-IP caps.

**Where the idea does hold is the ROOT.** `openbooks.space` ↔ `$OpenBook` is a genuine
correspondence: the root token has a real-world name and every other token hangs off it as a
path. Renaming the site to it is cheap — `ONCHAIN_APP` stays `opencook` regardless and
nothing on-chain moves.

**The plural is an accepted mismatch.** The domain is `openbooks.space` because no `openbook`
domain was available, while the root token is `$OpenBook`. The owner has decided not to
resolve or explain this. Recorded so it is not repeatedly rediscovered as a problem — it
isn't one.

## A post IS a token — 1-of-1, editioned by citation (SETTLED by the owner 2026-08-14)

**This is the base layer of the model, not a feature on top of it.** Every post mints a token to
its author at the moment of posting. No claim step, no opt-in, no "not yet": you write, you own.

**The edition grows by invocation.** A post starts as a **1-of-1**. When it is quoted or invoked
elsewhere, another unit is minted and it becomes a **1-of-2**, then a 1-of-3, and so on. The
supply of a post-token is therefore `1 + times it was invoked` — which means **a token's size is
a direct measure of how much the thing was actually used**, not of how loudly it was promoted.
Citation is the mint. This is the mechanism that makes contribution measurable without anyone
scoring it.

**Consequence — every token has a name, and almost all of them are unreadable.** A token needs an
identifier whether or not a human chose one, so the default name is the thing that already
identifies the post on-chain: its **txid**. Long, meaningless, unsayable.

**That is exactly what a `$Ticker` is for.** Claiming a ticker buys a unique, human-readable
alias over an otherwise incomprehensible identifier. It reframes the whole ticker system: not
decoration, not a tag, but the **naming layer over a universal token space** — and it explains
why ticker uniqueness is consensus-critical (`src/lib/ticker.ts`), why case-folding matters, and
why naming is a founding act worth paying for. The wallet deliberately shows unnamed tokens as
truncated txids rather than friendly invented labels, so the value of naming is visible rather
than argued.

**What the earlier framing got wrong.** A previous version of the wallet panel called this "your
threads" and footnoted it "not minted yet", on the reasoning that no mint had shipped so nothing
could be owned. The owner rejected that: it *"flies directly in the face of the model we're
building. Users create, and own, tokens when they post."* The distinction that actually holds is
**token vs market** — the tokens are real and owned now; what does not exist is a market (paid
posting, depleting supply, any way to trade). Only the market should be hedged in UI copy, and
`Manifesto.tsx` now says exactly that.

**SETTLED 2026-08-14 — the QUOTER holds the unit a citation mints.** Alice posts and holds 1 of
1. Bob quotes her: the edition becomes 1-of-2 and **Bob holds the new unit**. Carol quotes: 1-of-3,
Carol holds one. Tokens spread to whoever cites them, so a widely-invoked post ends up distributed
across everyone who found it worth invoking. The owner chose this over crediting the author,
knowing both consequences below.

**Consequence 1 — an author is diluted by other people's actions.** Alice's share of her own post
falls as it is cited, without her doing anything. This is the deliberate trade: it makes a token a
record of *reach* rather than of authorship, and it is what lets a token circulate at all. An
author who wants to keep their share can simply not be quoted, which is not a lever anyone would
pull.

**Consequence 2 — and this one is BLOCKING: quoting must COST something.** Free acquisition of a
thing that carries value is the exact failure this project has already ruled out — *anything free
that confers value destroys the anchor*. If quoting is free and quoting mints you a unit of
someone else's token, then minting is free, and the token means nothing. Today posting is free.

**Therefore citation-minting ships WITH paid posting, never before it.** This is not a sequencing
preference, it is the condition that makes the mechanism sound: under paid posting a quote IS a
post, so it costs the thread's current price, and the quoter is *buying* the unit they receive
rather than being given it. That is a coherent market. Shipping the mint first would hand out
free units that can never be recalled, since units are not reversible once they exist.

**Do not implement quote-minting until posting costs money.** If a future contributor finds this
tempting to build early, the answer is no, and the reason is the sentence above.

**Built today:** one token per post, held by the author, visible in the wallet with the holder's
percentage of each thread (`getHoldings` / `getThreadShare` in `src/app/actions.ts`). **Not
built:** citation-minting of additional units, and the market.

## The unit: fungible token, non-fungible instances (owner's taxonomy, 2026-08-14)

**Owner's formulation, recorded verbatim in substance:** invoking `$Parent` mints a COPY, which
the invoker pays for, buys, and keeps. There were one `$Parent` in circulation; now there are two
— the original author holds theirs, the invoker holds the new one. Each instance carries a
unique serial, and the parent token **does not distinguish between its instances**: it treats
them all as fungible units of itself.

**This is a semi-fungible token, and the analogy is a banknote.** Every £10 note has a unique
serial and is individually traceable, but no shop treats one as worth more than another —
non-fungible in identity, fungible in exchange. That is exactly the structure described, and it
is a real, well-understood shape rather than an exotic one.

**It maps directly onto the BSV stack we are already on.** 1Sat Ordinals gives each unit its own
satoshi with a unique outpoint (`txid:vout`) — the serial number, for free, already immutable —
while BSV-21 aggregates those units into a fungible supply under one `sym`. So the taxonomy the
owner reasoned to independently is what 1Sat/BSV-21 already implements. **This is a strong signal
the model is buildable as specified** rather than needing a bespoke contract.

**Two minting paths were described, and they are ONE rule.** (a) Quoting `$Parent` from
elsewhere. (b) Writing anything inside `$Parent`'s thread. Both are the same act —
**participation IS invocation** — and collapsing them means one rule to reason about instead of
two that could drift. Worth noting: **path (b) already exists in the code.** `getHoldings` counts
an author's posts in a thread as their holding in it, which is precisely "writing in the thread
mints you a unit". Path (a), quoting from outside, is the unbuilt extension.

**Supply stays bounded, so this does not contradict the depleting-supply model.** Every
invocation mints, but only until the thread's supply is exhausted, at which point the thread
closes (see *Closure*). Early units are cheap and later ones dear, so a founder's compensation
for dilution is that theirs cost least — which is the manifesto's existing "as it fills up the
tokens get scarcer and cost more", arrived at from the other direction.

### ⚠ OPEN — the separator is ambiguous, and it will harden into consensus

The owner wrote instances as `$parent/$post-1234h21huwery`. That collides with the meaning `/`
ALREADY has: `/$openbook/$test` means *`$Test` is a distinct CHILD TOKEN of `$OpenBook`*. Using
the same separator for *an instance of `$Parent`* makes one syntax mean two different things —
child token vs serial of the same token — and that is precisely the kind of ambiguity that
becomes unfixable once URLs are shared and records are on-chain.

**Recommendation: `/` for lineage, `#` for serial.** `$OpenBook/$Test` is a child token;
`$Parent#1234h21huwery` is instance 1234h21huwery *of* `$Parent`. `#` already reads as a serial
in ordinary English ("Issue #42"), and the two can then never be confused by a reader or a parser.

**⚠ SECOND HAZARD, and this one is a squatting vector: a serial must NOT live in the ticker
namespace.** If an instance is written `$post-1234h21huwery` with a leading `$`, then by the
existing parse rule it IS a claimable ticker — so someone could *claim the name of somebody
else's serial*, and first-claim-wins would let them. Serials must be structurally outside the
namespace `ticker.ts` governs. `#` achieves that too, since `findTickers` requires a leading `$`.

**Not built.** Recorded so the taxonomy is fixed before anything mints. Nothing here changes the
settled gate: minting of any kind ships WITH paid posting, never before it.

## $Nym — every user is their own issuer (owner's proposal, 2026-08-14)

**A user may claim a personal ticker — their `$Nym` — and every post they make mints one unit of
it.** Nobody else can ever mint that symbol. It is the user printing their own currency: the
supply is their own output, and what it is worth is entirely subjective. If somebody wants to buy
some, the holder can sell. Owner's framing, recorded as given.

**⚠ THE CRITICAL CLAUSE, AND IT IS NOT DECORATIVE: a token confers NOTHING.** It is not a claim
on revenue, on the platform, on the user's future work, or on anything else — unless and until
that user chooses to build something *contractually binding in script*. Until then it is a
receipt that someone wrote something, and a name.

This is worth stating precisely because it is what keeps the whole design out of the category it
would otherwise fall into. An instrument that automatically entitles its holder to a share of
someone's proceeds is a security nearly everywhere; a numbered receipt that entitles the holder
to nothing is not. **The "confers nothing by default" rule is doing legal work, not just design
work.** Anything that quietly attaches a default entitlement — a revenue share, a governance
right, a promise of future value — moves the whole system across that line for every user at
once. See also TOKENS.md's existing note that this must never feed allocation.

### How it sits alongside thread tokens

There are now two axes, and they are NOT the same thing:

| | issuer | minted by | supply |
|---|---|---|---|
| **Thread token** (`$Parent`) | the thread | anyone participating in it | finite, depletes, then closes |
| **Personal token** (`$Nym`) | one user | only that user, by posting | open-ended — their own output |

### ⚠ OPEN — these need answering before anything is built

1. **Does one post mint one token or two?** If posting in `$Parent`'s thread mints a `$Parent`
   unit AND a `$Nym` unit, a single act issues two different instruments. That may be right — the
   thread records participation, the nym records authorship — but it doubles the accounting and
   needs to be a decision rather than an accident.
2. **One namespace or two?** `ticker.ts` enforces globally unique symbols, first-claim-wins. If
   nyms share that namespace then claiming `$Alice` as a nym also blocks `$Alice` as a thread
   name. That is arguably correct (one name, one thing) but it means **nym-squatting is
   thread-squatting**, and the reverse: someone can take the name a person would have chosen.
3. **Is a nym claim reversible?** A thread name is permanent because a thread is permanent. A
   person may want to change their handle. Permanent-and-unique is the safer default and matches
   the existing rule, but it means a nym is a one-shot choice made by someone who has just
   arrived.
4. **What stops one user claiming many nyms** and printing several currencies? Nothing currently
   would. Whether that matters depends on (1).

**Not built.** The settled gate still applies: no minting of any kind ships before paid posting,
because anything free that confers value destroys the anchor.

## Supply cap vs divisibility — do not conflate them (raised 2026-08-14)

Owner floated capping every token at **100,000,000**, like satoshis in a bitcoin, while saying
they hold it loosely: *"It's arbitrary and it might make no sense. It might be that tokens get
divided indefinitely."* Recorded with the one distinction that decides it.

**These are two different numbers and only one of them is arbitrary.**

- **SUPPLY** — how many units a thread ever issues. This is load-bearing. The whole scarcity
  mechanic is that a thread's supply depletes, tokens get dearer as it fills, and **the thread
  CLOSES when the supply is minted out** (see *Closure*). At one token per post, a 100,000,000
  cap means a thread needs a hundred million posts to close. Closure would never happen, and the
  mechanic it exists to create — a finished thing, fixed forever, held by the people who built it
  — would quietly never fire. **A 100M supply cap does not make the design more bitcoin-like; it
  deletes the part that makes it a game.**
- **DIVISIBILITY** — how finely one unit can be split for trade. This one genuinely can be 100M
  and costs nothing. It is a protocol field, not an app decision: BSV-21 carries `dec`
  (decimals), and 1Sat Ordinals already gives each unit its own satoshi. Bitcoin's 100,000,000 is
  a DIVISIBILITY figure — a bitcoin is divisible into that many satoshis — not a supply cap. The
  supply cap is 21,000,000.

**So the analogy points the other way round from how it was framed.** The bitcoin-shaped design
is a *small* supply that is *finely divisible*, which is exactly what a depleting per-thread
supply plus `dec` gives.

⚠ **One tension to resolve before either number is fixed:** tokens here are semi-fungible —
each unit is a non-fungible instance with a serial (see *The unit*). **A serial cannot be split.**
Divisibility can therefore only apply to the fungible layer, or instances stop being instances.
Deciding to make units divisible is deciding they are NOT individually identified, which
contradicts the taxonomy the owner set out. Pick one.

**Recommendation:** leave divisibility at the protocol default and set no numeric supply cap yet.
The supply that matters is per-thread and should fall out of the pricing curve (how fast cost
rises as a thread fills), not be picked as a round number first. **Not built; nothing depends on
a number yet, so this can stay open without blocking anything.**

## We are ANCHORING posts, not inscribing them (established 2026-08-14)

Asked directly: *"are we 'inscribing' every single post?"* **No.** Checked, not assumed —
`src/services/bsv/onchain.ts` builds `OP_FALSE OP_RETURN <json>` (the envelope in
`src/lib/onchain-record.ts`). That is a **provably unspendable data output**: a permanent,
timestamped, signature-carrying RECORD of the post.

A 1Sat Ordinal inscription is a different thing — content inscribed into a P2PKH script on a
**1-satoshi output that is owned by an address and can be transferred**.

**So the honest position today: a post is a token in the database and in the UI, with an
independent on-chain audit trail beside it. It is not yet a token ON-CHAIN.** Nobody can transfer
or sell one, because there is no on-chain object to transfer. This is not a gap to paper over —
the wallet copy already says exactly this ("there's nowhere to trade them yet").

### ⚠ The sequencing this reveals: inscription, minting and paid posting are ONE milestone

They cannot sensibly ship apart, and noticing that resolves several open questions at once:

- **You cannot afford to inscribe for free.** An inscription costs more than an OP_RETURN (a
  1-sat output plus the envelope), and today the SERVER funds anchoring — there is a daily spend
  ceiling precisely because of that. Inscribing every free post puts an unbounded cost on the
  operator.
- **You cannot sell what was never inscribed.** The market needs on-chain objects.
- **Paid posting is what pays for the inscription.** The user funds their own token at the moment
  they mint it, which is also the moment the anchor stops being free — the rule that has governed
  every other decision here.

**Therefore: do not build inscription before paid posting, and do not build paid posting without
inscription.** One without the other is either an unfunded cost or an unsellable asset.

## Bitcoin Schema — what it gives us, and the one thing to be careful of (reviewed 2026-08-14)

bitcoinschema.org defines: Like, Follow, Friend, Post, Reply, Repost, Message, **Tags**,
Attachments, Payment, Function/Function Call, Registry Item, Ord — over MAP, AIP, B, BAP and 1Sat.

**`Tags` is the right primitive for something we cannot currently do: naming an EXISTING post.**
There is no mechanism to select a post and tag it with a `$ticker` — a ticker is only claimed by
writing it at post time. Retro-tagging is not a small change, for two reasons:

1. **A claim RE-ROOTS its post** (it becomes the root of its own thread). Retro-tagging someone
   else's post would MOVE it out of the thread it is sitting in.
2. **The post signature covers CONTENT ONLY.** A ticker added later cannot appear in that post's
   immutable on-chain record, so the chain and the database would disagree about what the post is
   called.

A separate, separately-signed Tag record — pointing AT a post rather than being part of it —
solves both: the post is untouched and unmoved, and the tag carries its own author and its own
anchor. It also cleanly separates *who wrote this* from *who named it*, which is the existing
open question "who may name someone else's post" in a form that can actually be built.

**⚠ Be careful with Like.** We already have the boost, and the boost's entire point is that
attention COSTS something. A free like is a second approval signal that costs nothing — it will
cannibalise boosting, and if it ever feeds ranking or allocation it breaks the anchor outright
(*anything free that confers value destroys the anchor*). If Like ships at all it should be
display-only and visibly lesser than a boost, or not at all.

**Repost/branching.** The owner notes Twetch did share-then-collect-on-later-branching and that
it was "correct". That is the same shape as the citation model already settled here — a quote
mints a unit to the quoter — so Bitcoin Schema's Repost is a compatible on-chain representation
of it rather than a competing idea. Same gate applies: not before paid posting.

## Every post is a token in your wallet, and you can sell it (owner's direction, 2026-08-14)

*"Users should be able to 'sell' their posts. Every post they have ought to be a token in their
wallet."* This is the direction, and it is the natural conclusion of the anchoring-vs-inscribing
finding above: to sell a post there has to be an on-chain object to sell, so each post becomes a
**1Sat inscription minted to the author's own address** at post time. Their wallet then literally
holds their posts.

**The listing mechanism that fits without breaking the no-custody rule: OrdLock.** A 1Sat listing
is a UTXO carrying a script anyone can spend by paying the seller — one transaction, no escrow,
nothing held in between. That is the same property the boost split already has, and the same
sentence already in the manifesto: *every satoshi leaves in the same transaction it arrived in*.
**A marketplace that took custody would contradict the thing this project exists to argue.**

### ⚠ WHAT IS AND IS NOT BEING SOLD — say this in the UI, not just here

Selling a post transfers **the token**. It does not, and cannot, transfer:

- **Authorship.** The post is signed by the original key and anchored on-chain. That is permanent
  and unpurchasable. Nobody can buy having said a thing.
- **The content.** It stays in the feed, unchanged, still attributed to whoever wrote it.
- **The right to remove it.** Nothing here can be unwritten by anyone, buyer or seller.

A buyer gets the on-chain object, its provenance, and whatever the holder later attaches to it.
**"Sell your post" must never be presented as selling your words** — that is a misreading a user
could plausibly make, and it would be our fault for allowing it.

### ⚠ THE QUESTION THAT DECIDES THE LEGAL SHAPE — unanswered

**Does selling a post transfer its FUTURE BOOST EARNINGS?**

- **Yes** → the token becomes a claim on someone's future revenue stream. That is much closer to
  a security nearly everywhere, and it directly contradicts the clause already doing legal work
  in this document: *a token confers NOTHING unless the holder builds something contractually
  binding in script.*
- **No** → you sell the object and its provenance. Value is subjective, exactly as the owner
  described `$Nym` ("what value it has is totally subjective"). Payouts keep following the
  signing pubkey (`services/fairness/weights.ts` attributes that way today), and anyone who wants
  earnings to follow a sale can write that into a script themselves.

**Recommendation: NO by default.** It keeps every token uniform — confers nothing until someone
chooses to make it confer something — and it is the only answer consistent with the rest of the
model. Making earnings follow automatically would silently reclassify every post on the board.

### Second-order question, worth settling before minting

**If a post claimed a `$Ticker`, does selling that post sell the NAME?** The ticker is registered
against `post_id`/`root_id`, so on the current schema the name is attached to the post, and
selling the post would hand over the name — including, potentially, a name that parents an entire
subtree of other people's threads. Either the name transfers with the token (simple, and means
buying a post can buy a namespace), or names are pinned to the claiming PUBKEY and stay put
(safer, but then a token's most valuable property does not travel with it). **Undecided.**

**Not built.** Inscription, minting and paid posting remain one milestone (see above), and nothing
mints before posting costs money.

## "Objects, not contracts" — where the argument holds and where it doesn't (2026-08-14)

Owner's position, recorded because it is theirs to make: a post is an **object** — a lighter,
cheaper NFT. Posts can generate real excitement and real money. Selling one therefore does sell
potential future revenue, and that is accepted. Their argument for why it is not a security:
*"a security is selling a contract, a breakable one — that's why it's regulated. Here we're
selling objects, not contracts, and users should NOT be able to break that contract, removing the
need for regulation."*

**The unbreakability point has real force.** A large part of why these instruments are regulated
is COUNTERPARTY risk: the issuer can fail to perform, misreport, dilute, or simply disappear. If
performance is enforced by script rather than by promise, that entire category of risk is gone.
This is the strongest form of "the code is the contract" and it is not hand-waving.

**But object-vs-contract is not the test that gets applied.** The US test (Howey) asks whether
there is money invested in a common enterprise with an expectation of profit **derived from the
efforts of others**, and it looks at economic reality rather than form — which is precisely why
"it's an object, not a contract" has not historically been a defence for tokenised things.

**So the better version of the owner's own argument is the "efforts of others" prong, not the
object framing.** If the payout is a mechanical split that nobody manages, curates or can
withhold, that prong genuinely weakens. The weakest point runs the other way: a buyer would
plausibly be buying a post *expecting future boost revenue*, and this platform builds and
maintains the machinery that produces it.

### ⚠ THE DECISIVE GAP IS TECHNICAL, NOT LEGAL — and we do not have it yet

**The argument only holds if the payout is enforced BY SCRIPT. Today it is not.**
`services/fairness/weights.ts` computes the split on our server, `split.ts` shapes it, and
`boot-orchestrator.ts` has our server build and broadcast the transaction. **That is breakable —
by us.** We could change the weights, stop running the sweep, or simply not pay. Every property
the "no regulation needed" argument leans on is currently a promise we are making, not a rule the
chain is enforcing.

To make *"users should NOT be able to break that contract"* actually true, the split has to move
into a **covenant** — the construction this document already describes for supply. Until then,
the honest description is: an object with a payout that this operator administers.

**Recommendation: the design can proceed on this basis, but get a real opinion before the MARKET
ships** — not before the tokens exist, before they become tradable for money. `legal/*.md` already
carries `[LAWYER]` markers for exactly this class of question. Nothing in this file is legal
advice and it should not be relied on as any.

## Bitcoin Schema — adopt the PROTOCOLS, ration the SCHEMAS (reviewed 2026-08-14)

Owner: *"seems like we should also implement all of these."* Recommendation is to split that in
two, because one half is nearly free and the other half is a pile of product decisions.

**Adopt the protocols for what we ALREADY emit — this is the high-value half.** We are already
doing Post, Reply, Attachments and Payment; we just express them in a bespoke envelope
(`lib/onchain-record.ts`, `{v, app, type, …}`). Nothing about our behaviour changes if those are
expressed as **MAP** attributes with **AIP** signatures and **B** for content — but our board
becomes readable by every other Bitcoin Schema application, for free, without shipping a single
new feature. **Interoperability is the point of the fork's whole argument: a contribution record
nobody else can read is a record only we can verify.**

Two caveats before anyone starts:

- **Old records stay as they are.** OP_RETURNs are immutable, so any reader has to handle both the
  bespoke envelope (2,000+ existing records) and the standard one. `onchain-record.ts` already
  documents that contract; bump `v` when the shape changes.
- **`ONCHAIN_APP` is still `opencook`.** There is a documented partial-sweep hazard around
  renaming it. Settle that before or with any format change, not after.

**Ration the social schemas — they are features, not formats:**

- **Tags** — the one genuinely worth building. It is the only way to name an EXISTING post (see
  the Bitcoin Schema section above), and it separates *who wrote this* from *who named it*.
- **Repost** — a compatible on-chain shape for the citation model already settled. Same gate:
  not before paid posting.
- **Like** — ⚠ **be careful.** It is a second approval signal that costs nothing, competing with
  a boost whose entire point is that attention costs something. Display-only and visibly lesser,
  or not at all.
- **Follow / Friend** — a follow graph turns a board into a feed-of-people. That is a different
  product with different dynamics, and it should be a deliberate decision rather than a schema we
  adopted because it was on a list.
- **Function / Function Call / Registry Item** — out of scope. These are for distributing software
  as inscriptions; nothing here needs them.

**Sequence: protocols first (no new features, immediate interoperability), then Tags, then
Repost with the mint. Like and Follow are product decisions to take on their merits.**

## Liking IS buying a unit — one primitive, three names (owner's design, 2026-08-14)

*"Liking a post is boosting it and buying a share into your wallet at minimum cost. You copy it
into your wallet at cost price. The amount of likes a post gets scales its number in circulation.
If you want to see how popular a post is, you can see how many tokens a post has."*

**This resolves the objection raised against a free Like** (see the Bitcoin Schema section): the
like is not free, so it cannot cannibalise the boost and cannot break the anchor. It is the boost,
at the bottom of the price range.

**It also collapses three things that were being designed separately into ONE primitive:**

| named as | what actually happens |
|---|---|
| **Like** | pay the post's current price, receive a unit |
| **Boost** | pay the post's current price, receive a unit |
| **Quote / cite** | pay the post's current price, receive a unit |

One action — *acquire a unit of a post by paying its current price* — with three affordances
pointing at it. That is a large simplification, and it means **popularity is denominated in
supply**: how many tokens a post has issued IS how many people paid to hold a piece of it. No
separate like counter, no separate ranking signal, nothing free to inflate.

### ⚠ THE ONE CONFLICT TO RESOLVE: is the price FLAT or ON A CURVE?

A **flat** "minimum cost" contradicts a mechanic already settled in this document: a thread has a
**depleting supply**, tokens **get scarcer and cost more** as it fills, and **the thread CLOSES
when the supply is minted out**. A flat mint price means unbounded supply and no closure — the
game stops being a game.

**These reconcile if "minimum cost" means the current price on a RISING curve** — minimum at the
*start*, not forever. Which is what the earlier design already says. Then:

- The first person to like a post pays least. **Spotting something early is the position that pays
  off**, without any "get in early" promise being made — it just falls out of the curve.
- Later units cost more, so supply is soft-capped by price rather than by a number picked in
  advance (see the supply-cap note above, which recommended exactly this).
- Closure still happens.

**Recommendation: the like/boost/mint price is the thread's current price, and it rises.**

### On the dilution the owner already spotted

*"if social posting creates MORE of the tokens then the POST content gets MORE valuable as it's
tokenised more and more often, which implies that the value of the tokens in your wallet goes DOWN
over time — but I'm not bothered about that."*

The observation is right, and worth completing: **per-unit value only falls if attention grows
more slowly than supply.** Supply grows one unit per liker. Whether each unit is worth less
depends on whether the post's total standing grows faster than that — and on a rising curve, each
new unit is sold at a higher price than the last, which sets a rising floor rather than a
diluting one. So the outcome is not automatic in either direction.

There is also a genuine asymmetry worth naming: **the author is diluted the most and benefits the
most.** Their share falls as the post spreads, which is the same trade already accepted for
citation-minting (*the quoter holds the new unit*), and it is what makes a widely-held post a
measure of reach rather than of authorship.

**Not built.** Same gate as everything else here: nothing mints before posting costs money.

## SETTLED: mint revenue follows ownership (owner, 2026-08-14)

*"If I BUY a post off you… whoever likes it, the revenue goes to me. That's a convention, enforced
by ownership."*

**Settled.** I recommended the opposite (see the sellable-post-tokens section, which argued for
keeping payouts on the signing pubkey to stay consistent with *a token confers nothing*). The
owner decided otherwise and this is the position of record. The security-shape caveat already
written above still stands and is not repeated here — it is a matter for the lawyer, not for
re-argument.

**It is also the choice that makes a post market mean anything.** If revenue did NOT follow
ownership, a buyer would be trading provenance alone — a receipt for something that pays someone
else forever. Because it does follow, the price of a post becomes an estimate of its **future
attention**, which is the only thing that makes a market in posts worth having.

### ⚠ "Enforced by ownership" needs a lookup we do not currently have

Today the money goes to the **signing pubkey**: `services/fairness/weights.ts` attributes by
pubkey, and `api/boot-confirm` **derives the credited address from a verified ECDSA signature** —
deliberately, because deriving it rather than accepting it is what closed a boot-attribution
forgery hole (see the boot-confirm notes in CLAUDE.md).

Routing to the *current holder* means resolving **who holds the inscription's outpoint at the
moment of payment**. That is a chain lookup, not a signature derivation, and it has consequences:

- **The unforgeable property goes away.** A signature proves who signed; it cannot prove who
  currently owns a token. Ownership has to be READ from the chain, and reading it wrong — or
  trusting a client's claim about it — reintroduces exactly the forgery class that was closed.
- **The payee becomes mutable.** Every payout path currently assumes a stable recipient derived
  from a key. It would need to tolerate the recipient changing between two payments for the same
  post, which is a different invariant from the one those paths were written against.

**None of this argues against the decision** — it is the work the decision implies, recorded so
it is not discovered late.

### ⚠ UNSETTLED, AND IT MATTERS: what exactly is "the post" that gets bought?

Under *like == mint*, the author holds unit #1 and every liker holds one of #2…#N. So "buying the
post" has two possible meanings:

1. **Buying unit #1** — one token among many, which happens to be the first.
2. **Buying the issuer position** — the right to receive revenue from all FUTURE issuance.

The owner's sentence implies **(2)**. But if unit #1 is what carries that right, then **the genesis
unit is not fungible with the others**, and the semi-fungible model recorded above (all instances
interchangeable as units of the same token) has one exception at its centre. That may well be
correct — a first edition is not an ordinary edition — but it should be a decision rather than
something discovered when the first post is sold and two people disagree about what changed hands.

**Options, undecided:** the issuer position rides on unit #1; or it is a separate object that can
be sold independently of any unit; or every unit carries a pro-rata share of future revenue (which
makes units uniform again but turns each one into a revenue claim, sharpening the legal question
rather than softening it).

**Not built.** Same gate: nothing mints before posting costs money.

## ⚠ FLAT COST-PLUS PRICING — the owner is reconsidering the curve below (OPEN, 2026-08-14)

*"I dont know that the price per token should go up… I think maybe tokens should be sold at cost
price or a very slight markup that no one will notice but which builds a multi squillion dollar
corporation."*

**This is a challenge to the linear curve settled immediately below, not a refinement of it.** The
section below is left intact and unedited: it is the reasoning that has to be answered, and the
decision is NOT yet made. What follows is what changes if flat pricing wins.

### What flat pricing keeps, and keeps better

- **The anti-pump ceiling gets STRONGER, not weaker.** The curve's whole anti-pump property is
  that nobody rationally pays more second-hand than the cost of minting fresh. At a flat price
  that ceiling is flat and low *forever* — you cannot detach a resale market upward from a price
  that never rises. Pumping is not bounded by arithmetic here; it is priced out entirely.
- **Platform inventory stays safe.** The reason the curve mattered for the genesis-and-copies model
  is that it removes discretionary pricing, so the platform selling copies of what it minted is not
  self-dealing. A flat public price does that at least as well.
- **The landgrab stays affordable to US.** ~20,000 names for $2 (DIRECTION.md) assumed near-cost
  minting. Under an escalating curve, the platform's own bulk claiming gets more expensive exactly
  where it matters most — the common vocabulary that everybody names.
- **The business becomes volume, not scarcity.** Inscription on BSV is a fraction of a cent, so a
  markup nobody notices is fractions of a cent. That is a rails business — revenue is
  `tiny × enormous`, which is the "multi squillion" bet and a different company from one that
  monetises scarcity.

### ⚠ WHAT IT COSTS — the dilution defence, and this is the real question

**An escalating price is what makes diluting somebody self-limiting.** Supply is unbounded and a
holder's share is `mine / total`, so anyone who posts a name repeatedly dilutes every existing
holder. Under the curve the 200th mint costs 200×, so an attack on a valuable name prices itself
out. **Flat, at cost, it does not:** taking a holder from 100% to 1% costs ~99 × a fraction of a
cent, plus the rate limits (10/min per pubkey, 200/day per IP) as the only real brake.

So the choice is not really about revenue. It is:

> **Is a token an INVESTMENT or a RECEIPT?**

- If tokens are **investments**, a share must be defensible, and the curve is the defence.
- If tokens are **receipts** — provenance, "I said this, here is the record" — then dilution is
  just spam, rate limits are the right tool, and a share is a description of participation rather
  than a position anyone should be able to protect.

The owner's own framing (*"Own what you post"*, the manifesto's ownership pitch) reads much closer
to RECEIPT than to investment, which is a genuine argument for flat pricing. But **it is
incompatible with treating `mine/total` as a holding worth defending**, and the wallet currently
presents it as exactly that. Whichever way this goes, the two have to agree.

**Not decided. Do not implement either pricing until it is** — and note that neither can ship
before paid posting exists at all.

## Mint price scales LINEARLY, and supply is unbounded (owner, 2026-08-14)

*"Maybe the amount of dilution per token IS infinite, but the price to mint a new token scales.
Cost price for the first, twice cost price for the second, three times for the third — linear, not
exponential, otherwise keywords can't realistically be bought and proliferate."*

**Linear is the right shape and doubling would have been fatal.** A doubling curve is absurd after
about thirty mints; nobody could buy into a popular name at any price. Linear per-unit pricing
means the TOTAL cost of N units is `C·N(N+1)/2` — quadratic overall, which is expensive enough to
be a real bid and cheap enough that names proliferate. Inscription cost on BSV is a fraction of a
cent, so `C` can be genuinely small, which is what makes the bottom of the curve accessible.

### ⚠ THIS REPLACES CLOSURE — say so, do not leave two contradictory sections

An earlier settled decision in this document (*Closure — a thread ends when its supply is minted
out*) says a thread has a FINITE supply and **closes** when it is exhausted: fixed forever, held
by the people who built it. **A linear price with no cap means supply is unbounded and a thread
never closes.** The owner accepts this explicitly — *"the amount of dilution per token IS
infinite"* — so this supersedes closure rather than sitting beside it. If closure is wanted back
it needs a separate mechanism (a price ceiling, or an owner-triggered close), not the supply cap
that has now been given up.

### The property this buys, which is the anti-pump one

**The mint curve is a PRICE CEILING on the secondary market.** If anyone can mint a fresh unit at
`N·C`, nobody rationally pays more than `N·C` for a second-hand one. So the resale market cannot
detach upward from the curve — **the structure caps pumping without anybody policing it.** That is
a direct answer to *"crypto is geared towards pump and dumps"*: here the pump is bounded by
arithmetic.

The exception is the **genesis unit / issuer position**, which is unique and carries future mint
revenue (see *revenue follows ownership*). That one can and should trade above the curve — it is
a different object from an ordinary unit, which is the ambiguity already flagged there.

## Non-goals

- Not a presale, not a public sale, not a fundraise. Tokens are earned or bought at mint,
  matching the upstream principle that value comes from contribution.
- Not a governance token. Token-weighted voting is the plutocracy failure mode already
  identified in DIRECTION.md's table (Botto row).
- Not a rebrand. `ONCHAIN_APP` stays `opencook` until OpenBook runs its own mainnet
  deployment — see the partial-sweep hazard note in `src/lib/onchain-record.ts`.

## Open questions

1. **What is the token a claim on** — the thread's boot revenue, or just a name? Decides
   whether this is an instrument or a ticker, and everything about disclosure follows.
2. **Who receives the parent's share at each mint?** The covenant makes it enforceable; it
   does not decide whether the recipients are parent-holders pro rata (fan-out cost) or a
   single distribution output.
3. **How often is the split snapshot refreshed**, and what attests the new payout list?
4. **Is the mint one-per-thread or open?** Determines whether a thread has one token or
   many.
5. **What does `launchTs` mean for minting?** Pre-launch genesis posts are pool-excluded —
   can their threads mint?
6. ~~**How many tokens does one contribution mint?**~~ **ANSWERED 2026-08-14:** tokens track
   payment, and payment tracks post length against the thread's current curve price. No
   scoring step. A `weights.ts`-based allocation was proposed and **rejected for breaking the
   one-move property** — anything needing a formula to justify what someone received is a
   worse product than "you paid, here are your tokens", whatever its properties.
7. **Is there an emission curve within a thread — should early contributors get more?**
   **ANSWERED IN PRINCIPLE 2026-08-14 — yes, via the depleting supply.** Early contributors
   get more because tokens are cheaper early, not because a multiplier favours them. The
   curve's *shape* is still unset, and the cautions below still apply to how steep it is.
   Original reasoning:
   the person who replies to a thread of 3 took a real risk on an unproven idea; the person
   who replies at 3,000 is joining something already working. A declining curve prices that
   difference. Three things have to be weighed against it, and none is settled:
   - **It converts a contribution reward into a timing reward.** The steeper the curve, the
     more the optimal strategy is "post early in everything" rather than "post well". That
     is the *free-post weight-farming* vector already logged as SECURITY_AUDIT **L8**, with
     a new and much larger payoff attached.
   - **It is the mechanism the upstream table indicts.** DIRECTION.md's Friend.tech row —
     *"pure speculation, no intrinsic value, bubbles pop"* — describes early-buyer-advantage
     curves specifically. A bonding curve makes the thread's token a bet on the thread's
     growth, which is a different instrument from a claim on its revenue (open question 1),
     and the two answers must agree.
   - **It interacts with the parent's per-mint share.** If both the child curve and the
     parent share are in play, the root's L1 concentration (see *Risks*) compounds with
     early position, and the operator holds the root.

   None of that says no. It says the curve's shape is an economic decision with a security
   consequence, and it should be made after question 1, not before.

8. ~~**What happens when a thread's supply is exhausted?**~~ **ANSWERED 2026-08-14: the
   thread CLOSES.** Minted out means finished. See *Closure* below.

9. **A ticker's percentage as a NOVELTY INDICATOR — good, and worth building.**

   Raised 2026-08-14. First recorded here as a recommendation AGAINST, on the reading that the
   percentage was an ownership share. **That reading was wrong and the recommendation is
   withdrawn.** The percentage is a *saturation gauge shown as you type*:

   - `$Something (100%)` — nobody has ever used this name. You are about to **CLAIM** it.
   - `$OpenBook (0.0001%)` — heavily used and long claimed. You are **CITING** it.

   Reframed that way the earlier objections dissolve:
   - *"It measures typing, not value"* — measuring usage is precisely the point. Saturation is
     the thing being displayed.
   - *"It is free to grief"* — driving the number DOWN makes a ticker look MORE established,
     which flatters the claimer rather than harming them. There is no stake to dilute.

   **Why it is more than a nice touch.** Under the mint gesture, naming an unclaimed ticker is
   a paid founding act and naming a claimed one is a citation — two very different actions
   behind the same keystrokes. This indicator is the **disclosure that tells them apart BEFORE
   the send button is pressed**, which is exactly what *The mint gesture* says the button owes
   the user. The percentage is doing consent work, not decoration.

   **What still holds from the earlier note:** the number must never FEED allocation. Mentions
   are free, and anything free that confers value destroys the anchor (*the payment is the
   proof of contribution*). Display only.

   **Open on presentation, not on principle.** `1/N` reads well at the extremes — `100%` is
   unmistakably "new" — but `0.0001%` is hard to parse and a percentage beside a token still
   invites an ownership reading in a crypto-literate audience. A count (`1 of 12,000 uses`)
   carries the same information without that ambiguity. The binary — claimed or not — is the
   high-value half either way, and should be unmistakable at a glance.

**On hard-capping supply** — asked 2026-08-14, initially answered "not open", then **resolved
the other way the same day.** The original objection was mechanical: a minted supply has to
sit at an address, and whoever holds that key custodies it. That objection is still correct
about a supply held at an *address* — but a depleting supply held in a **covenant** is a
different construction, already demonstrated by `HashToMintBsv20`, and it delivers the
scarcity without the treasury. See *Why a per-thread cap is now possible — and was not
before*. Per-thread supply is capped and depleting; total supply across the tree is not.

## Tagging: a tag is a MENTION WITH A TARGET, and it claims the word (SETTLED by the owner 2026-08-14)

*"if you can tag posts you can tag tags in posts like `$MEMEPLEX ($pretentious)`."*

### What prompted it — the incentive the live board exposed in its first hour

Read the feed on launch day: of twelve posts, **nine were bare one-word ticker claims**
(`$SEO`, `$KEYWORDS`, `$SEARCH`, `$SOCIALGRAPH`, `$clickme`, `$openbooks`, `$MEMEPLEX`×4) and
three were the only posts containing an argument. **The three posts carrying the ideas minted
nothing at all**, because no ticker appeared in their text.

That is the whole problem in one screen: **the cheapest possible act — typing one word — captured
every asset, and writing a thought captured none.** Left alone, the equilibrium is a registry, not
a board: bare claims strictly dominate prose, because they cost the same (nothing) and take
seconds. The owner reached this from the other direction, noticing that the *prose* post was the
valuable one and had no token.

**Tagging is the repair.** It is the only mechanism that lets a post accumulate tokens **from
readers, after the fact**, rather than only from words its author remembered to type. It is what
makes writing competitive with claiming.

### The model: a tag is a mention with a target

Do not build tagging as a fourth primitive. It is the primitive already settled in *Liking IS
buying a unit*, with a name attached:

| | what it is |
|---|---|
| inline `$MEMEPLEX` in prose | an **untargeted** mention |
| tagging a post `$profound` | a mention **pointed at that post** |
| tagging a ticker `$MEMEPLEX ($pretentious)` | a mention **pointed at that ticker** |

So the edge is `(from_post, ticker, target)` where **`target ∈ {post, ticker, null}`** — one
nullable target plus a type discriminator. Everything else is machinery that already exists:
supply already counts *posts that mention a ticker* (`getTickerSupply`), so tags feed the existing
counter, the existing `formatShare`, and the existing first-claim-wins PRIMARY KEY. Nothing about
the namespace changes.

⚠ **Design the target column now even though the build is gated.** Supporting `target ∈ {post,
ticker}` from the start is one column; retrofitting a second target type onto a populated edge
table is not.

One act, four consequences: **you pay the post's current price → the author earns (revenue follows
ownership) → you hold a unit of the post (like == boost == quote) → and `$profound`'s supply grows
by one.**

### Tagging CLAIMS the word (owner's call)

Asked explicitly whether tagging with an unclaimed word claims it or merely mentions it: **it
claims it.** The first person to tag anything `$COOL` becomes the genesis holder of `$COOL`.

This is consistent with every other rule here — *claiming posts it*, one rule for every name, no
second class of ticker — and it is deliberately a land-rush on the vocabulary of praise. That is
the intended consequence, not an overlooked one: the common words of approval are exactly the
namespace the platform is trying to own early, and a tag is a founding act like any other.

Two mechanical notes that follow:

- A tag with a **reserved** word is SKIPPED, not refused, like every other reserved claim — the
  tag still records against any other name it carries. A reservation list must never become a word
  filter.
- Tagging **does not re-root** the tagged post. The retro-tagging objection recorded in the
  Bitcoin Schema section stands: a claim re-roots its post, so retro-tagging someone else's post
  would MOVE it out of its thread, and the post signature covers content only. A tag is a
  **separately-signed record pointing AT a post**, so the post is untouched, unmoved, and its
  on-chain record still matches its content.

### This is the SEO thesis arriving

**A tag is a keyword someone PAID to attach to a document.** That is not adjacent to *economically
weighted SEO keywords* (DIRECTION.md) — it is the thing itself, and it is a better signal than an
inline mention because it is deliberate and directed rather than incidental to prose. The
`/tickers` index already ranks by supply; tags are what make that ranking legible to an outsider.

### Negative tags are load-bearing, and the economics already handle them

`$SCAM`, `$BORING`, `$PRETENTIOUS` are permanent, on-chain, and attached to someone else's post.
**The griefer pays the post's owner to insult them** — harassment is a transfer TO the target.
That defence falls out of *revenue follows ownership* for free and needs no moderation apparatus,
which is the correct shape for this project's thin-core stance. Do not add a reporting flow for
negative tags; the price is the flow.

### ⚠ The gate is the same gate

Tagging is the citation-mint act with a label on it, so it inherits the rule that already governs
that act: **do not ship tagging before posting costs money.** If tags are free, `$COOL` is on
everything within a day and the signal is dead before an outsider ever sees it — and the free
units can never be recalled. *Anything free that confers value destroys the anchor.* **Cost is the
entire filter**; without it tagging actively accelerates the noise it was built to fix.

## Pay-to-post: a post is a lightweight NFT, and its ID is its OUTPOINT (owner's direction 2026-08-14)

*"we also want 'pay to post' where a post IS a lightweight NFT, a distinct token with an ID. the
ID is … the substance of the token presumably I dont know, but at least it's ON CHAIN then."*

### What the ID is — and the distinction that matters

**The token's identity is its origin outpoint: `<txid>_<vout>`.** The substance — content, author,
signature, tags — is the payload carried on that output.

The owner's instinct that the ID *is* the substance is nearly right, in the way that matters:
**the outpoint cryptographically commits to the substance without being it.** The txid is a hash
of the whole transaction, payload included, so the content cannot change without changing the ID.
You get the property you want (identity inseparable from substance) without the failure the
literal version causes.

Why not the alternatives, each ruled out for a specific reason:

- **The SQLite `id`** (what the OP_RETURN carries today) is *our database's* identifier. It is
  meaningless if the DB is lost, and two forks of this codebase would issue colliding ids. It
  stays as a local index; it must never be the token identity.
- **A hash of the content** collides on purpose: if you post "gm" and I post "gm", those must be
  **two distinct tokens with two distinct owners**. Content-addressing cannot express that.
- **The outpoint** is chain-native, unique without coordination, survives our DB dying, and is
  already what 1Sat Ordinals uses — so wallets, indexers and marketplaces understand it with no
  bespoke work from us.

### What has to change to make this real

This is the milestone already identified in *We are ANCHORING posts, not inscribing them*, now
with the owner's framing attached. Today a post's on-chain presence is `OP_FALSE OP_RETURN <json>`
— a **provably unspendable** output. It is a record. **It cannot be owned or transferred, because
there is nothing there to spend.**

A lightweight NFT means the post's data rides on a **1-satoshi spendable output held at the
author's address**. Ownership becomes "whoever can spend that satoshi", transfer becomes an
ordinary BSV transaction, and the wallet literally holds the user's posts. That is the difference
between an audit trail beside the token and the token itself.

**Pay-to-post is what funds it**, exactly as already recorded: the author pays to mint their own
token at the moment they create it, which is the same moment the anchor stops costing the operator
money. Inscription, minting and paid posting remain **ONE milestone** — this section does not
change that sequencing, it names the artifact the milestone produces.

### Still open, deliberately

- Whether the tag edge is its own inscription (its own outpoint, separately owned and sellable) or
  a record referencing the tagged post's outpoint. The tag being *separately signed* is already
  settled; whether it is separately **ownable** is not.
- Whether `id` and `parent` stay in the OP_RETURN envelope once outpoints are canonical. They are
  additive optional fields, so they can stay harmlessly — and the 2,006 already-anchored genesis
  records mean `v` does not get bumped either way.

## Build order

1. **Threading** — `parent_id` / `root_id`. Done; see THREADS.md.
2. **Ticker registry + mint fee** — namespace and pricing, no chain yet.
3. **Declare the claim** — repo-token semantics, `undeclared` default.
4. **Paid posting + inscription** — ONE milestone, never apart. A post becomes a 1-sat
   spendable output identified by its outpoint; the author funds their own mint. This is the
   gate everything below waits on.
5. **Tagging** — the edge table (`target ∈ {post, ticker, null}`), immediately after the gate
   opens. Design the target column earlier than this; only *ship* it here.
6. **Pay-to-mint covenant** — the sCrypt work. Read `htm-contract` in full first.
7. **Token-backed `WeightSource`** — the seam is already in place.
8. **Boot revenue → token holders**, where the cascade turns on.

## Key files

- `src/services/fairness/weights.ts` — the `WeightSource` seam; the only file a token layer
  must replace
- `src/services/fairness/split.ts` — consumes weights, indifferent to their origin
- `src/services/fairness/config.ts` — `halfLifeDays`, `platformCut`, `launchTs`
- `src/lib/onchain-record.ts` — envelope + reader contract; a `token_mint` record type is
  additive and needs no `v` bump
- `src/lib/db.ts` — `applyThreadingMigration`

## Upstream relationship

**Potentially upstreamable** — useful to OpenCook independent of tokens:

- The FAIRNESS.md scaling-table correction (its fixed-10,000-sat scenario contradicts
  `calculateBootPrice`).
- The `WeightSource` seam — a behaviour-preserving refactor.
- Threading, if upstream wants replies.

**Fork-only** — do not attempt to upstream:

- The token layer itself. It takes the opposite side of a documented, deliberate upstream
  decision, and submitting it as a PR would misrepresent the fork's intent.
