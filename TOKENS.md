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

### Who receives the tokens — reuse the split that already exists

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

## Build order

1. **Threading** — `parent_id` / `root_id`. Done; see THREADS.md.
2. **Ticker registry + mint fee** — namespace and pricing, no chain yet.
3. **Declare the claim** — repo-token semantics, `undeclared` default.
4. **Pay-to-mint covenant** — the sCrypt work. Read `htm-contract` in full first.
5. **Token-backed `WeightSource`** — the seam is already in place.
6. **Boot revenue → token holders**, where the cascade turns on.

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
