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
- **Posting must stay free.** The button only becomes Mint when a `$ticker` is present. A
  post without one is exactly what it is today, at no cost. This is the *"paying to mint is
  a founding act; paying to post is a different product"* line in the risks section, made
  structural rather than a policy anyone has to remember.
- **A failed mint must not silently become an ordinary post**, and an ordinary post must
  never accidentally mint. `$` appears in normal prose ("$50", "$OpenBook" as a reference).
  The parse rule needs a deliberate shape, and the ambiguous cases resolve toward NOT
  minting.

**Not built.** Nothing about minting exists yet — no ticker registry, no fee, no covenant.
Building the button before the thing it triggers would be a button that lies.

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

## Supply and dilution

Mint-on-allocation means **uncapped supply**, which has two consequences.

**It needs an anchor.** Free minting is free money and worth nothing. Issuance must be paid
for by the act that triggers it — the payment gives each token a cost basis. This is what
makes the mint price load-bearing rather than a fee bolted on.

**Continuous dilution replaces the decay curve.** This resolves the stock-versus-flow
tension better than the "decay-adjusted issuance" this document originally proposed:
uncapped mint-on-contribution *is* continuous dilution, so contributor #500 is not shut out
by a closed cap table, and no 30-day half-life is needed to prevent accumulation.

**The parent's share must be per-mint, not one-off.** A one-time parent allocation dilutes
to nothing as the child grows. So it has to mean: every child mint also produces the
parent's output, enforced by the covenant. Note the arithmetic — a 50% parent share means
the contributor receives half of what is minted on their behalf, and supply grows at twice
the contribution rate.

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
- **Pay-to-post would end zero-friction onboarding.** Posting is free today; the server
  covers ~$0.0005. DIRECTION.md's whole onboarding claim rests on it. Paying to **mint** is
  a founding act and a natural fee; paying to **post** is a different product. Keep them
  separate.

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
6. **How many tokens does one contribution mint?** Raised 2026-08-14 and completely open.
   *Supply and dilution* settles that issuance is uncapped and paid-for, but not the rate.
   A flat "N tokens per contribution" makes weight meaningless; scaling by the existing
   `weights.ts` score reuses machinery that is already tested and already resistant to the
   gaming analysed in FAIRNESS.md. That is the obvious first answer and it has not been
   examined.
7. **Is there an emission curve within a thread — should early contributors get more?**
   Raised 2026-08-14. The intuition is sound and matches how the value actually arrives:
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

**On hard-capping supply** — asked again 2026-08-14, and it is not open: see *Custody: why a
fixed supply cannot work*. The objection is mechanical rather than economic. In a UTXO
model a minted supply has to sit at an address, and whoever holds that key custodies it, so
a cap does not buy scarcity — it buys a treasury and the counterparty risk that comes with
it. Uncapped mint-on-allocation is what lets the design stay non-custodial. The scarcity
intuition behind the question is real, but the place to express it is the emission rate
(question 6) and the curve (question 7), not a ceiling.

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
