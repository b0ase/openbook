# Direction

> Where this project is going and why. Read this before suggesting features or architecture changes.
>
> **OpenBooks is a fork of OpenCook, and it diverges on economics.** This document is
> upstream's direction, kept because most of it still holds and because the reasoning is
> worth preserving. Three sections are now superseded and say so inline: *Onboarding
> Philosophy* (posting is paid), *Yeah, we pump* (there IS a token), and *The Recursive
> Model* (spawning is driven by supply exhaustion, not by traction alone). The token model
> lives in [TOKENS.md](TOKENS.md); thread structure in [THREADS.md](THREADS.md).
>
> **On the two names:** "OpenCook" is kept wherever it means the upstream project, its
> historical firsts, or its authorship of the fairness rules — those statements are true of
> upstream and it would be dishonest to relabel them. "OpenBooks" is used where the sentence
> describes the product a reader is actually using. Both are accurate; neither is a leftover.

## The Vision

**Tagline:** *A platform that builds itself, then lets anyone do the same.*
**Subtitle:** *Agentic Fairness*

Start with literally nothing — just a board for posting ideas. Every post is logged on-chain (BSV). A fairness agent tracks contributions. The platform evolves based on what users request. Eventually, any post can become its own project with the same model.

**"The first proof that this works is the platform itself."**

The platform is not built then launched. It is planted as a seed and grown with the community. Every person who posts an idea, suggests a feature, or helps shape direction becomes a contributor with on-chain proof of participation. Contributions are tracked from post #1.

## Who This Is For

Everyone. Not just developers.

The person in Lagos with a brilliant idea but no money for a patent. The ex-Google architect who disagrees with how things are built but has no platform to prove it. The graphic designer browsing spawned projects at midnight, offering their eye for UI. The attorney who spots a legal gap. The music artist who wants fair royalties. The marketer who knows how to make things spread. The property owner with an idea for how rentals should work. The teenager with vibes and nothing else.

**OpenBooks doesn't care who you are. It cares what you did.**

Every contribution is timestamped on-chain. An anonymous user posting as `anon_k` gets the same credit as anyone else. No resumes, no interviews, no gatekeepers. You contribute, you're credited, you earn. The poorest person with the best idea earns the same as the richest person with the same idea.

This is a permissionless global workforce:
- The idea people who can't code but know exactly what should exist
- The coders who can build it
- The designers who make it usable
- The marketers who make it spread
- The users who just have vibes — and vibes are signal too
- The experts who flip through 10 spawned projects a day offering their skills anonymously

You don't apply. You don't interview. You just show up, contribute, and the system tracks it forever.

## The North Star

The endgame isn't one platform. It's a universal system where **whoever contributes first, gets credit — provably, permanently, across every project that uses their work.**

An idea posted on-chain has a timestamp. If someone codes that idea later, the original poster gets credit — the idea came first. If code exists before someone posts it as an idea, the coder gets credit. On-chain timestamps are the arbiter. No disputes, no committees, no politics.

This works across forks. OpenCook is open source, and **OpenBooks is that claim being tested rather than asserted** — this project is a fork of it, diverging on economics while keeping the contribution history. Anyone can fork it, improve it, launch their own version. That's not a threat — it's the model working. Contributors don't pick sides. They post ideas, write code, and earn proportionally from every project that uses their contribution. The best projects attract the most activity. Competition drives quality, not lock-in.

**How it works:**
- Every contribution is timestamped on-chain (posts, code commits linked to BSV identity)
- Priority is provable — who was first is a fact, not an opinion
- The fairness system distributes revenue to contributors in real-time
- As new contributions come in, everyone's share adjusts live
- If code gets removed, contributions adjust downward
- This happens across all forks and spawned projects simultaneously

**Why open source is the only strategy:**
- Every fork proves the model works — that's compounding credibility
- The value isn't the code (anyone can copy it) — it's the community, the on-chain history, and the rules everyone plays by
- OpenCook designed the fairness rules. That's the moat. The code is just the implementation.

**What exists today:** On-chain posts, contribution scoring, trustless split payments, zero-friction identity (key generated silently, encrypted in place when protected — no rotation, no migration chains). The foundation.

**What comes next:** Cross-project contribution tracking, code-commit linking to on-chain identity, a shared protocol for forks to recognise each other's contributors. Phase 7 of the build roadmap (see `ROADMAP.md` — "The Recursive Model") is the first step toward this. (Note: this Phase 7 is from the build roadmap, distinct from the fairness-system phases listed in the next section.)

## Where We Are Now

OpenCook is the first project built on this model — the proof that it works before anyone else uses it.

**The fairness system is live but in trial mode.** Right now it rewards posting and boot activity. This is the working proof of concept — real money flows, real payments split, real on-chain records. But it's Phase 1.

**What's coming** (fairness-system phases — separate numbering from the build roadmap):
- Fairness Phase 1 (now): Fairness rewards posts and boots. Proves the mechanics work. Rules are being refined.
- Fairness Phase 2: Fairness starts tracking real contributions — code that ships, ideas that get built, bugs that get fixed. The AI agent evaluates actual impact, not just activity.
- Fairness Phase 3: The AI adjusts its own parameters within bounded ranges. Boot signals are one input into governance alongside project owners and human oversight. The balance between agentic and human control will evolve.

**Important for contributors:**
- The existing fairness splits are a working prototype, not the final system
- Contribution scores will evolve as the scoring model matures
- Some or all existing parameters may be updated or refined
- Everything is work in progress — that's the point. The platform builds itself.

Once this model is proven on OpenCook, any idea posted here can spawn its own project using the same fairness system. OpenCook is the seed. The vision is the forest.

## The Core Loop

1. User posts idea
2. Logged on-chain (immutable record)
3. Fairness agent watches (learns who contributed what)
4. Features get built (by team, agents, or community)
5. Platform evolves
6. Contributors get credit (based on on-chain history)
7. Repeat

## Onboarding Philosophy

**SUPERSEDED for OpenBooks (2026-08-14) — posting is paid.** The upstream position is kept
below because what survives of it is most of it.

**Still true, and still the hard part:**

- Visit site → see a text box → type → post. No separate onboarding flow.
- BSV keypair generated automatically behind the scenes.
- No wallet downloads. No seed phrases. No third-party wallet to install.

**No longer true:** *"no buy crypto first"*, the server covering the ~$0.0005 per post, and
the **~15% conversion vs industry ~0.3%** target that rested on both. Under OpenBooks's token
model every post is a purchase — you pay to post and receive the thread's tokens as a
tradable receipt (see TOKENS.md, *Supply and dilution*). A first-time user must have funded
their address before their first post.

**This is a deliberate trade, not an oversight.** The bet: fewer users who are actually
buying something, over more users whose contribution is counted but not owned. It is the
fork's entire thesis, and it costs the single biggest number in this document. Anyone
quoting the 50x conversion figure for OpenBooks is quoting a claim that no longer applies.

**What replaces it as the onboarding problem:** getting a first-time user funded without
reintroducing the friction the keypair generation removed. That problem is unsolved and is
the thing to design against.

## The Recursive Model

Once the platform works, any post can become its own project. Someone posts an idea, it gets booted (economic signal), and if it gains enough traction it spawns into its own platform with the same contribution tracking, fairness agent, and model.

"Every idea is a seed. Every seed can grow into a forest."

**AMENDED for OpenBooks (2026-08-14) — spawning has a mechanism now, not just traction.** A
thread's token supply depletes as people post into it, and **when it is minted out the thread
closes**. The natural continuation of a closed thread is a child thread, which mints its own
token and gives the parent a share.

So branching stops being something users have to be persuaded to do and becomes what the
economics push toward: threads fill up, and the conversation continues in a child that pays
its parent. The forest grows because the seeds run out of room. See TOKENS.md *Closure*.

### What could be built

It doesn't matter what the idea is. The model works for anything:

- **A travel app** — "locals should review restaurants, not tourists." Someone posts it, it gets booted, a project spawns. A designer contributes the UI. A developer builds the backend. The person who posted the original idea earns from the project forever — because they were first and it's provable.
- **A music platform** — "artists should own their distribution." Every listen splits revenue: the artist, the person who had the idea, the developers who built it, the designer who made it beautiful. All in one transaction.
- **Social media** — "users should own the algorithm." Spawns, contributors build it, the fairness system distributes revenue to everyone who helped. No venture capital needed.
- **A cooking community** — recipe creators earn when their recipes get used. Meal planning apps spawn from it. Revenue flows back to the original contributors.
- **Anything** — a marketplace, a booking system, a game, a tool. The subject doesn't matter. The model is the same: post the idea, build it together, earn proportionally.

### How project ownership works

The person who spawns a project becomes the project owner. They can:
- Direct development priorities
- Set the initial fairness parameters for their project
- Use OpenBooks's community as their first users and contributors
- Drop tokens to their users if they want (BSV-21 — nothing stops them)
- The fairness system tracks contributions automatically — no payroll, no invoicing

### Yeah, we pump. We pump real value.

**SUPERSEDED for OpenBooks (2026-08-14) — there IS a token, and it is the point.** Upstream's
position is preserved verbatim below, because it is the strongest argument against what this
fork is doing and deleting it would be self-serving.

> There's no OpenCook token. No presale. No "buy our coin." The value IS the contribution.
> You earn by doing, not by speculating.
>
> If a project owner wants to issue their own token on their spawned project — loyalty
> points, governance tokens, whatever — that's their choice. But the base layer is always:
> real work → real payment. The fairness system pays in real money (BSV), not promises.

**OpenBooks's position.** Every post is a purchase: you pay to post, and you receive the
thread's tokens as a tradable receipt on a supply that depletes. Tokens are still not sold in
a presale and still not a governance instrument — they are minted by the act of contributing,
priced by what you write, and the payment *is* the proof of contribution. But calling this
"no token" would be false, so it is not called that.

**What survives from upstream's argument, and matters more here than there:** real work →
real payment. The boot-fee revenue split is unchanged and still pays in BSV, not promises.
The token sits alongside it, not instead of it.

**What upstream is right about, on the record:** this design increases speculation and
securities exposure, and its own competitive table (below) names the failure mode. See
TOKENS.md *Risks and honest counter-arguments*, which does not dismiss them.

You can sit on the platform and talk. You can share ideas. You can contribute code. It is all
signal. The difference is that now you own a piece of the thread you signalled in.

## Open Source Strategy

This project will be open source. The repo is designed to be **AI-native** — when anyone clones it, their AI assistant should immediately understand full context, direction, and what to work on.

Context lives in the repo (CLAUDE.md, DIRECTION.md, DECISIONS.md, ROADMAP.md). AI is instructed to update these as it works, so documentation stays current automatically.

Enforcement is phased: start with instructions only, add hooks when contributors arrive, add CI when patterns of breakage emerge.

## Competitive Positioning

OpenBooks inherits a combination that exists separately elsewhere but had not been put together on a chain where the economics work — and then changes the economics. The table below is upstream's analysis; read the note after it for where the fork no longer gets to claim its answers.

### Why existing approaches failed

| Platform | What they tried | Why it failed | OpenCook's response |
|----------|----------------|---------------|-------------------|
| **Steemit/Hive** | Community-rewarded on-chain posts | Whale-dominated voting, inflationary tokens, reward farming | AI-adjudicated fairness, real revenue not inflation, no stake-weighted politics |
| **SourceCred** | Algorithmic contribution scoring | Synthetic tokens not real money, organization dissolved | Real BSV micropayments, sustainable revenue from boot fees |
| **Coordinape** | Peer-based contribution allocation | Subjective, political, doesn't scale | AI removes human politics from distribution |
| **Twetch** | BSV on-chain social with micropayments | Required wallet upfront, killed onboarding | 2-click onboarding, identity generated silently |
| **Friend.tech/DeSo** | Social tokens, speculation on creators | Pure speculation, no intrinsic value, bubbles pop | Rewards actual contribution, not speculation — **but see the note below: OpenBooks's token model moves toward this row, not away from it** |
| **Botto** | AI + community + value distribution | Token-weighted voting (plutocracy risk), aesthetic not contribution | AI evaluates contribution quality, inverted agency model |

**Where OpenBooks must be honest about this table.** The Friend.tech row indicts
early-buyer-advantage on assets nobody can evaluate. OpenBooks's model — pay to post, tokens
cheaper early, on a name whose thread has not happened yet — is structurally closer to that
row than upstream is. The claimed difference is that the token is minted by contributing
rather than bought from a bonding curve on a person, and that a thread's supply is finite and
closes. Whether that difference holds is the open question, not a settled advantage. Recorded
here so the table is not quoted as if the fork inherited its answers.

### What makes OpenCook possible (and why nobody else did it)

**BSV's micropayment economics.** A single transaction splitting payment to 30 contributors costs ~$0.003 on BSV. This is economically impossible on Ethereum (gas) or BTC (block space). The reason Steemit used token inflation, SourceCred used synthetic "Grain", and Coordinape uses peer tokens is that real-money micropayment splitting to dozens of contributors doesn't work on high-fee chains. BSV removes that constraint.

### The 4 genuine innovations

1. **Agentic Fairness as a governance framework** — The 4-phase autonomy ramp (human-set → AI suggests → AI adjusts → fully agentic) with constraint-bounded parameter tuning. No other project has productized this.
2. **Zero-friction crypto identity** — Keypair generates silently on first visit. User never knows they "have crypto." Progressive security upgrade when it matters.
3. **On-chain key migration** *(prior art — shipped on mainnet, then superseded)* — Old key cryptographically signs a handoff to a new key, posted on-chain; contribution history followed across rotations. Built and operated on BSV mainnet, then removed at launch (2026-06-14) in favour of encrypt-in-place (simpler UX, no rotation). Retained as timestamped prior art — see FAIRNESS.md. *(Current identity model: the key/address never changes; a passphrase encrypts the existing key in place.)*
4. **Real-money contribution splitting** — Single BSV transaction, dozens of outputs, sub-cent fees. Revenue-based, not inflationary. The fairness model cannot be faithfully replicated on other chains.

### The proof moment

The innovation lives or dies on one demo: **a user posts an idea, someone boots it, and the user receives satoshis without ever having set up a wallet.** Everything else is table stakes until that flow works end-to-end.

## What This Is NOT

- Not a crypto wallet app
- Not a social media platform (yet — it may evolve into one)
- Not a fundraising tool
- Not built on bOpen.ai — bOpen is the toolkit, the product is OpenBooks

---

## What this is actually for: a ranking signal that costs money (2026-08-14)

Written in answer to *"zoom out — what's the most profitable outcome for everyone? What model
produces real value over the long term?"*, and against the owner's own lean: build slowly, like
Amazon, rather than pump.

### The primitive we already have, described plainly

A `$Ticker` is **a globally unique name, owned by whoever claimed it first, attached to a body of
content, with a price that rises as more people buy into it.**

That is a keyword with a market price. The owner's framing — *"$cashtags are, long term, SEO
keywords on a graph"* — is right, and the thing it implies is bigger than SEO.

### The thesis

**Google's ranking signal is free to produce, which is why it is failing.** Links are free. Clicks
are cheap. Content is now nearly free to generate at unlimited scale. Every signal conventional
search relies on can be manufactured more cheaply than it can be verified, which is why the open
web is filling with material written to rank rather than to be read.

**Here, ranking costs money by construction.** To make `$ForestFire` prominent you have to buy
into it, at a price that rises with every prior buyer. A spam signal that costs real money at an
increasing rate is not a spam signal — it is a bid.

**This is not advertising, and the difference is the whole point.** An advertiser pays the
platform and the money leaves the system; they are rewarded for spending, on anything. Here the
payer **acquires a stake in the thing they promoted**, and the money goes to the people who built
it. You are not buying attention — you are buying *into*. Promote something worthless and you are
left holding it.

### The best expression: a market for standing questions

The owner's three examples are three different objects, and the difference matters:

- `$ELONMUSK` — an **entity**
- `$FORESTFIRE` — a **topic**
- `$WEATHERINLONDON` — a **standing question**

The third is the strongest and the most defensible. It is not a document; it is a question that
needs a *current* answer, forever. Search engines answer it by re-crawling the world every day.
This architecture can answer it differently: **a persistent, owned, economically-maintained place
where the best current answer lives** — where the owner profits from keeping it good, because a
stale answer stops attracting the buy-ins that give the name its value.

**So the long-term shape is not "a board with tokens". It is an index of things people need to
find, where maintaining quality is the profitable move and gaming it is expensive.**

That is a decade-shaped business, and it is the opposite of a pump: the asset is the index, the
index improves with use, and the incentive points at usefulness rather than volume.

### Honest weaknesses

- **Capital can corner names.** Someone rich can buy `$ELONMUSK`. Mitigated — a rising price makes
  cornering quadratically expensive, and buying out holders enriches whoever was early — but not
  eliminated. This is the strongest objection and it should not be argued away.
- **Early names are a landgrab.** First-claim-wins on a globally unique namespace rewards whoever
  arrives first, permanently. That is a feature for bootstrapping and a fairness problem later.
- **Thin markets are noisy.** A name with three buyers is not price discovery. The signal only
  means something at volume.

### ⚠ Two contradictions between this thesis and the code today

1. **There is NO SEARCH.** You cannot find a `$Ticker` — not by name, not by popularity, not at
   all. **A keyword index you cannot query is not an index.** This is the single largest gap
   between what the project is and what this thesis says it is for.
2. **The site is `noindex`.** `ALLOW_INDEXING` is unset, so `app/robots.ts` serves `Disallow: /`.
   An SEO play is currently invisible to search engines. Correct for a quiet launch, and
   self-defeating the moment this thesis is the plan.

### How to get there with the primitives that already exist

In order, cheapest and highest-value first. **None of this needs the token market to ship.**

1. **Search over tickers.** Name, prefix, and content. Nothing new is required.
2. **A `/tickers` directory ranked by economic weight.** `getTickerSupply` already computes it —
   supply IS demonstrated demand. This is the index, and it exists in fragments already.
3. **Flip `ALLOW_INDEXING` at go-public**, so the outside web can see the names.
4. **Make it machine-readable** — Bitcoin Schema (MAP/AIP/B) plus a public API. **AI agents are
   becoming the main consumers of search, and unlike humans they can pay.** An index that is
   on-chain, economically weighted and machine-readable is more useful to an agent than to a
   person, and agents are the readers most able to act on it.

Steps 1–3 are days of work and would make the thesis testable long before any market exists. If
the index is not useful when the names are free, a price will not make it useful.

### ⚠ The dictionary landgrab — costed, 2026-08-14

Asked: *"how much would it cost to mint a dictionary's worth of keywords as tokens on BSV?"*
The arithmetic matters less than what it implies.

**The arithmetic** (substitute your own rates — this is the shape, not a quote):

```
per inscription ≈ tx overhead + inscription script + 1 sat output
                ≈ ~300 bytes  ≈ ~300 sats at 1 sat/byte
100,000 words   ≈ 30,000,000 sats ≈ 0.3 BSV
200,000 words   ≈ 60,000,000 sats ≈ 0.6 BSV
```

Batching several inscriptions per transaction cuts the overhead sharply, and BSV fee rates below
1 sat/byte are routine. **So: tens of dollars, not thousands. A fraction of one coin.**

**That number is the problem, not the good news.** First-claim-wins on a globally unique namespace
where the total cost of claiming *the entire English language* is a restaurant bill means **one
actor can own every common word before anybody else arrives.** If that happens the index is dead
as a public good: every standing question people actually search for would be owned by whoever ran
a script first, and the market for them never forms.

This is the weakness recorded above ("capital can corner names") at a magnitude that changes its
character. It is not *a rich party could corner some names*. It is *anyone with pocket money could
corner all of them*.

**What currently stands in the way — and it was not designed for this job.** A ticker can only be
claimed BY POSTING it, and posting is rate-limited: **10 posts/minute per pubkey** and
**`ONCHAIN_POST_IP_LIMIT` (default 200) per IP per day** (`src/app/actions.ts`). At 200/day, one
IP needs ~500 days to claim 100,000 names. That is a real gate, but it is an ABUSE control that
happens to be load-bearing for namespace fairness, and it is defeated by renting IPs.

**Options, none decided:**

- **Make claiming cost more than posting.** A claim is a founding act; pricing it separately from a
  post is the most direct lever, and TOKENS.md already anticipates the claim eventually costing
  money.
- **Escalating cost per claim per identity** — the Nth name an identity claims costs more than the
  first. Attacks the accumulation directly rather than the rate.
- **Require the name to be USED** — a claim that never attracts a second post decays or is
  reclaimable. Cuts against permanence, which is a core promise, so it would need care.
- **Reserve a dictionary list** so common words must be earned rather than bought. Simple and
  paternalistic; hard to draw the line.

**This should be settled before `ALLOW_INDEXING` is turned on**, because the moment the index is
publicly visible is the moment the landgrab becomes obviously worth doing.

### Pre-claiming the namespace is INVENTORY, not rent (owner's correction, 2026-08-14)

An earlier version of this document called the platform pre-claiming dictionary words
"landlordism". **That imported a moral framing the owner does not share, and it was the wrong
objection.** Corrected here rather than quietly edited, because the reasoning matters.

**The owner's framing, which is sound:** a user-minted token at 100% of a supply of 1 is worth
nothing and cost real money to create. Minting is not a gift being handed out, so pre-claiming is
not a gift being withheld. Buying keywords ahead of customers is **capital outlay on inventory** —
what a retailer does stocking shelves, or a publisher buying a back catalogue — for a business
whose shape is not yet known. **Low-cost insurance against the landgrab costed above.**

**The objection that actually stands is structural, not ethical.** Three things are true at once:

1. the platform would own the genesis unit of every common word,
2. **revenue follows ownership** (settled in TOKENS.md), and
3. the platform sets the mint price.

Together those mean *the operator sets the price of the inventory it holds and collects on every
trade in it*. That is not wrongdoing — it is the conflict of interest that exchanges are normally
structured to avoid. And it matters here for one specific reason: **the entire thesis on this page
rests on the price signal being trustworthy.** An index whose prices are set by the largest holder
is not obviously a better signal than the free ones it claims to improve on.

**The resolution is already decided elsewhere in this project: the LINEAR curve.** A deterministic,
public price rule means the operator cannot price at discretion — the curve does, identically for
everyone. Fix the curve in code, disclose the platform's position plainly, and the conflict is
largely neutralised. **The pricing decision made for other reasons turns out to be what makes
platform inventory safe.**

### Doing it on $2

The owner holds roughly $5 of BSV and wants to spend at most $2. That is enough, and the shape of
the answer matters more than the exact figure.

```
~300 sats per inscription
$2 at ~$30/BSV ≈ 0.067 BSV ≈ 6,700,000 sats ≈ ~20,000 names
```

(Assumed rates — substitute real ones.) **$2 buys roughly the common vocabulary**, which is where
the entire landgrab risk lives. Nobody is going to corner `$Sesquipedalian`. The long tail can be
claimed by whoever actually wants it, which is the outcome this project should prefer anyway.

**⚠ But none of it can happen yet.** We anchor, we do not inscribe (TOKENS.md), and inscription,
minting and paid posting are one milestone. There is nothing to buy today.

**The free version, available immediately: a reserved-words list.** Marking common words as
unclaimable-by-others in the database costs nothing, is reversible, and removes the landgrab risk
now — with the platform releasing or minting them properly once inscription ships. It buys the
same insurance for £0 and does not require deciding the ownership question first.

### Reserving and land-grabbing are the same ACT — the release is the difference

Owner, 2026-08-14: *"the landgrab concept and the reserved register are the same thing unless
we're just creating infrastructure for our platform, which I think we might be."*

That is exactly right, and worth stating plainly rather than dressing up. **Claiming a name to
hold it and claiming a name to corner it are the same action.** Nothing about the mechanism
distinguishes them. The only thing that does is what happens next:

- **Landgrab:** claim → hold → extract.
- **Reservation:** claim → hold → **release, or issue on terms everyone can see.**

So the release path is not a nice-to-have on this feature — **it is the entire difference**, and
a reservation with no stated release policy is a landgrab with better manners. Which is why
`releaseTickers` exists alongside `reserveTickers`, why the list is a TABLE rather than a
constant (releasing must not require a deploy), and why reserving can never take a name somebody
already holds.

**What is still missing is the commitment**, and only the owner can make it: under what conditions
does a reserved name get released or issued, and to whom? Until that is written down, this feature
is insurance with no policy document.

### Why "inscribe and chill" was empty and this is not

The owner's read on the ticker-inscription wave — *"like telling people not to register domain
names, but rather to claim paths on a URL"* — identifies the real flaw. **BSV-21's `sym` is not
unique.** Two people can inscribe the same ticker and both hold something; neither holds THE name.
So the thing being sold was the act of inscribing, not an exclusive claim — which is why it
behaved like squatting on a path nobody has to respect.

**This namespace is the opposite, and that is precisely why the landgrab risk here is real.**
`tickers.symbol` is a PRIMARY KEY, canonicalised to uppercase so `$openbook` and `$OpenBook` are
one claim, and the parse rule is treated as consensus-critical (`src/lib/ticker.ts`). First claim
wins, permanently, and there is exactly one holder.

**Enforced uniqueness is what makes a claim worth something — and therefore what makes cornering
the dictionary worth doing.** The same property that gives the index its value is the one that
creates the exposure. That is the honest reason this reservation is not paranoia.

