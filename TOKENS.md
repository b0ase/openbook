# Tokens

> Fork-direction document. This explores adding a token layer to the fairness model — the primary way OpenBook intends to diverge from upstream OpenCook.
>
> **Status: nothing here is decided.** No design below is implemented. This document exists to make the fork's intent legible and to record the analysis behind it. When a design is chosen, the decision moves to DECISIONS.md and this file becomes the rationale trail.
>
> Last updated: 2026-08-14

## Why this document exists

Upstream OpenCook states plainly that it has no token (DIRECTION.md, "Yeah, we pump. We pump real value"). That is a deliberate position, well-argued, and backed by a competitive table showing how token-based predecessors failed — Steemit's whale-dominated voting, SourceCred's synthetic Grain, Friend.tech's speculation collapse.

OpenBook takes the opposite side of that bet. This document sets out where a token attaches, what it would fix, what it would break, and — importantly — which parts of the upstream analysis survive scrutiny and should be respected rather than waved away.

## The attachment seam

`split.ts` does not know where weights come from:

```ts
calculateSplit(bootFeeSats, creatorPubkey, creatorAddress, platformAddress, weights: ContributorWeight[])
```

`ContributorWeight` is `{ pubkey, address, weight, postCount, totalBoots }`. Everything about *how* weight is earned lives in `weights.ts` (111 lines): scan posts since `launchTs`, compute `sqrt(1 + boots × 1.5) × 0.5^(age/30)`, sum by pubkey.

**That function is the entire attachment surface.** A token layer replaces or blends into its return value. Downstream — the payment builder, the OP_RETURN audit envelope, the boot orchestrator, the no-custody guarantee — is indifferent to the change.

This is the single most important fact for planning the fork: the divergence is one function wide, not a rewrite.

## What the current model actually is

The current weight is a **flow**, not a **stock**. It is recomputed from the posts table every 30 seconds and decays with a 30-day half-life. It is never stored.

The consequence is worth stating precisely, because it is the gap a token would close:

> With a 30-day half-life, a contributor who stops contributing retains **~1.5% of their weight after six months** (0.5^6). The on-chain *record* of their contribution is permanent. Their economic *claim* is a rapidly-expiring annuity.

Upstream documentation describes contributions as "tracked forever" and credit as "provable, permanent." Both are true of the archival record and false of the payout claim. The docs do not distinguish these. A token is the natural instrument for making the claim as durable as the record.

## Three designs

### A. Receipt token

Mint a BSV-21 token to the contributor's address on each post or boot. `weights.ts` is unchanged; the token records contribution but carries no claim on revenue.

- **Pro:** additive, cheap, no economic change, arguably upstreamable as an opt-in feature.
- **Con:** economically inert. This is a badge, not a token. It does not close the permanence gap because the payout still runs off the decaying weight.

### B. Revenue-share token

Token balance *is* the pool weight. `weights.ts` becomes "read balances from the token indexer" rather than "scan the posts table." Tokens are transferable, so a secondary market in future boot revenue forms.

- **Pro:** this is the real version. Closes the permanence gap; makes the claim bearer-enforceable and therefore portable across forks (see Cross-project claims below).
- **Con:** deletes the decay curve, which exists specifically to prevent accumulation. Introduces an indexer dependency on the money path. Carries securities exposure (see Risks).
- **Not upstreamable.** This is a different product, not a feature.

### C. Dual-track

The sat flow stays exactly as-is — boot triggers an atomic split, unchanged. Tokens mint in parallel as a claim on a treasury.

- **Pro:** preserves the working, audited money path untouched.
- **Con:** requires inventing a revenue source that *accumulates*, which the current no-custody rule forbids by construction. You cannot have a treasury and "every sat out in the same transaction" simultaneously. Adopting C means explicitly retiring the no-custody guarantee, which is one of the project's four claimed innovations.

## The core tension

The 30-day half-life exists to stop accumulation. A token is a stock; the current weight is a decaying flow. They are opposite instruments, and any design must pick a side:

- **Permanent tokens** → contribution never decays → early contributors dominate indefinitely → precisely the whale dynamic the upstream competitive table blames for Steemit's failure. Adopting B naively reproduces a documented failure mode.
- **Decaying tokens** → requires burn or demurrage mechanics → you have reinvented the weight table with extra steps and an indexer dependency.

The interesting middle ground is **decay-adjusted issuance**: mint permanently, but let the issuance *rate* fall as circulating supply grows. The stock is durable (closing the permanence gap) while the marginal reward for identical behavior declines over time (preserving the anti-accumulation intent). This is the design most worth prototyping first.

## What a token would and would not fix

Claims here are grounded in the code, and two of them correct errors in upstream FAIRNESS.md.

### The revenue ceiling — real, and tokens address it

`calculateBootPrice` is `max(1000, min(250000, activeContributors × 156))`. Above ~1,603 active contributors the price is pinned at the 250,000-sat ceiling while the pool keeps subdividing. At 5,000 contributors the pool is 200,000 sats — 40 sats each, and falling from there.

A token ledger decouples payout accounting from per-recipient UTXOs, so value can accrue to holders without the pool being physically divided into dust each event. **This is the strongest technical argument for the fork's thesis.**

### Transaction bloat — NOT a real problem

An earlier version of this analysis claimed each one-post drive-by permanently adds an output to every future boot. That is wrong. `split.ts` computes `share = Math.floor(poolSats × w/W)` and emits an output only `if (share > 0)`, so a contributor whose decayed weight rounds below one sat drops out of the transaction entirely. Decay plus that floor prunes the tail automatically. Output count is self-limiting.

Recorded here so the fork does not build on a false premise.

### The denominator divergence — real, bounded, probably intentional

The two contributor sets differ:

| | Filter | Window |
|---|---|---|
| `countActiveContributors` (sets price) | `HAVING COUNT(*) >= 3` | rolling 30 days |
| `calculateWeights` (sets pool) | `pubkey IS NOT NULL` | none — all posts since `launchTs` |

Pricing is windowed and filtered; the pool is neither. A band of contributors — 1–2 posts in the window, or posts aged past 30 days but not yet decayed to dust — receives outputs without contributing to the price. Transaction size can therefore exceed what the price was set to cover.

Bounded by the pruning above, and plausibly a deliberate choice (conservative pricing, inclusive payouts) rather than a bug. Noted, not treated as a defect.

### Upstream FAIRNESS.md scaling table is incorrect

The table varies contributors from 5 to 5,000 while holding the boot at a fixed 10,000 sats, and concludes fees exceed the boot at 5,000 contributors. `calculateBootPrice` makes that configuration impossible — 5,000 active contributors yields the 250,000-sat ceiling, where a 17,211-sat fee is ~7%.

The table and the pricing code contradict each other. This is a clean upstream bug report independent of anything token-related.

## Cross-project claims

Upstream's North Star is contribution credit that follows a person across forks and spawned projects. FUTURE.md sketches this as cascading batch payments to parent treasuries, then concedes the load-bearing part: *"No license can enforce royalties — it's a protocol problem, not legal... Protocol membership is the incentive."*

That is voluntary compliance. Sats are fungible and carry no lineage, so a fork that strips the royalty output is visible on-chain but unstoppable. A token held by contributors is bearer-enforceable — the claim travels with the holder rather than depending on each downstream operator's goodwill.

The upstream endgame is reachable without tokens only in a world where every fork chooses to honor it. This is the second strong argument for the fork's thesis.

## Risks and honest counter-arguments

These are the reasons upstream may be right. They are not dismissed.

- **Securities exposure.** A transferable token entitling holders to a pro-rata share of platform revenue closely resembles an investment contract. Sats-paid-for-work does not. Upstream already has unresolved money-transmitter and broadcaster-liability questions pending legal review; a revenue-share token materially enlarges that surface. **This must get lawyer time before design B ships anywhere near mainnet.**
- **Speculation displaces contribution.** The failure mode in the upstream competitive table is real and repeatedly observed. Once a token is tradeable, the incentive to acquire it by purchase rather than by contributing exists permanently and cannot be designed away, only dampened.
- **Indexer on the money path.** Design B makes payouts depend on a token indexer being correct and available. The current model depends only on the local SQLite posts table. This is a genuine reliability regression on the most sensitive path in the system.
- **The no-custody guarantee.** Design C cannot coexist with "every sat out in the same transaction." Retiring that is a real loss, not a technicality.

## The unissued claim

Worth recording, because it shapes what "adding a token" means here.

| Party | Claim | Decays? |
|---|---|---|
| Contributors | 80% pool, by weight | Yes — 30-day half-life |
| Boosted creator | 15% bonus, per event | N/A — one-shot |
| Platform | 5% of every boot, in perpetuity | **No** |

The platform cut is a non-decaying, non-dilutable, perpetual claim on all platform revenue held at a single address. Structurally that is a founder's allocation with no vesting — it simply was never named, issued, or made transferable.

This is not an accusation of self-dealing; the same operator excluded all 1,908 backdated genesis posts from the pool via `launchTs`, a costly choice made against their own interest. The likelier reading is that the platform cut was modelled as "server costs" and never as a claim.

But it means the honest framing of this fork is **not** "adding a token to a token-free system." It is: *a permanent claim already exists and exactly one party holds it; the question is whether others get one too.*

## Non-goals

- Not a presale, not a public sale, not a fundraise. If a token exists it is earned, matching the upstream principle that value comes from contribution.
- Not a governance token. Upstream's Agentic Fairness phases put parameter control with an AI agent under human bounds; token-weighted voting is the plutocracy failure mode already identified in the competitive table (Botto row).
- Not a rebrand. The on-chain `app` tag stays `opencook` until OpenBook runs its own mainnet deployment — see the note in `src/lib/onchain-record.ts` on the partial-sweep hazard.

## Open questions

1. Which design — A, B, or C? Current lean is B with decay-adjusted issuance, prototyped behind an interface so `weights.ts` can be swapped without touching `split.ts`.
2. What is the mint trigger — post creation, boot receipt, or both? Boot-triggered minting inherits existing anti-spam protections; post-triggered minting does not.
3. Does the 5% platform cut become a token allocation, stay as a sat stream, or get retired? Naming it is a prerequisite to justifying anyone else's allocation.
4. How does token supply interact with `launchTs`? Pre-launch genesis posts are pool-excluded upstream — do they mint?
5. Does the token carry lineage metadata for cross-project claims, or is portability handled at the protocol layer above it?

## Upstream relationship

Keeping these separate matters for whether PRs are mergeable.

**Potentially upstreamable** (small, self-contained, useful to OpenCook independent of tokens):

- The FAIRNESS.md scaling-table correction.
- Making `weights.ts` pluggable behind an interface — a refactor with no behavior change.
- Design A (receipt token) as an opt-in, default-off feature.

**Fork-only** (do not attempt to upstream):

- Design B or C. These take the opposite side of a documented, deliberate upstream decision. Submitting them as PRs would misrepresent the fork's intent.

## Key files

- `src/services/fairness/weights.ts` — the attachment seam; the only file a token layer must replace
- `src/services/fairness/split.ts` — consumes weights, indifferent to their origin; should remain untouched
- `src/services/fairness/config.ts` — `halfLifeDays`, `platformCut`, `launchTs`; the parameters a token design must reconcile with
- `src/services/fairness/pricing.ts` — the 250,000-sat ceiling that motivates the revenue-ceiling argument
- `src/lib/onchain-record.ts` — the `app` tag and reader contract; any new on-chain token record type goes through this envelope
