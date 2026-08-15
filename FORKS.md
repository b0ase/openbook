# Forking $OpenBooks

This file describes a **convention**, not a licence condition. The code is MIT (see
[LICENSE](LICENSE)) and stays MIT: you may fork, copy, modify and sell this without asking
anyone, without paying anyone, and without honouring anything below.

The convention is what we do anyway, and what we ask forks to do. Its enforcement is not a
court — it is that this repository, and the board it runs, make the record public and
permanent. A fork that follows the convention can prove it. A fork that doesn't is visibly a
fork that didn't.

---

## The convention

**1. A fork tokenises itself.** Mint a token whose genesis inscription names the fork's own
repository URL. That inscription is the token's origin — its `<txid>_<vout>` outpoint — and the
repository URL is what it points at. One repo, one token, one origin.

**2. A fork gifts 50% of that token to the repository it forked from.** Not to us specifically
— to its own immediate parent. Sent on-chain, to an address the parent has published.

**3. The gift is passed upward.** Whoever receives a gift under this convention pledges to send
**50% of what they receive** to the repository *they* forked from, and so on to the root.

That third rule is what makes it a convention rather than a tax. A grandchild's gift reaches
the root as a quarter, a great-grandchild's as an eighth. Ancestry is rewarded, decays with
distance, and no one at the top collects everything.

**4. It is all public.** Publish the txid. A claim to have honoured this that cannot be checked
on-chain has not honoured it.

---

## The terms of the token

Fixed at issue and not adjustable afterwards:

- **One token, one contract address.** Stated in the instrument. There is no second series.
- **Fixed supply.** BSV-21 has no separate mint step — `deployBsv21Token` deploys *and* mints in
  one operation, with the whole supply in `initialDistribution`. There is no minter role to
  retain, so the supply cannot be increased by anyone, including the issuer.
- **No supersession clause.** The instrument does not reserve a right to issue a later token
  representing the same repository at a new address.
- **The covenants bind the ISSUER, not the recipient.** No signature is required to hold a
  gifted position, and none is required to keep it.

⚠ **The supersession clause was drafted and then cut, deliberately.** A reserved right to
re-issue would mean the token does not represent the repository — it represents a claim its
issuer may replace at will, which is the standard criticism of tokens rather than an answer to
it. It could also never be exercised without destroying the point of the gift, so it was a
power that could only ever be used destructively while weakening the instrument on every
reading. **Do not re-add it.**

⚠ **Nor is receipt gated on signing anything.** A gift conditional on the recipient ratifying
the giver's framing is not a gift; it is an offer, and it can be refused on the framing alone.
Obligations here point at the issuer so that there is nothing for a recipient to accept, and
the position survives their disagreement with everything else in this file.

---

## The licence, and a correction

An earlier version of this file said a licence condition could not do this. That was too
pessimistic, and the correction matters because it changes what is on offer.

A condition **can** be a term of the copyright licence, if it attaches to the right act:

> Distributing or commercially using a derivative of this repository requires registering the
> derivative and assigning 50% of its tokens to the parent. Viewing and forking remain free, as
> GitHub's terms require for a public repository. This condition is a term of the copyright
> licence, not a platform rule, and applies whether or not the derivative is registered.

**Not "forking"** — GitHub's Terms of Service already grant every user the right to view and
fork a public repository, and no licence added later retracts that on GitHub's own platform.
**Distributing or commercially using a derivative** is what copyright actually controls.

Two things this repository does **not** claim, for the same reason:

- **We can't licence what we don't own.** This repository is a fork of MIT-licensed
  [OpenCook](https://github.com/Challotes/opencook). Upstream's grant flows through
  irrevocably; conditions added here bind only our own additions.
- **We are not owed anything by our own past, and nor is upstream owed by us.** OpenCook never
  published a fork term. **An unpublished term is not a default — it is the upstream not having
  asked.** So the 50% sent upstream is a GIFT, not the settlement of a debt, and describing it
  as a debt would be inventing an obligation nobody set.

Which is why the terms above are published *before* anyone forks this repository, rather than
asserted afterwards against someone who has already forked it.

---

## What we have done

| | |
|---|---|
| **This repository** | https://github.com/b0ase/openbook |
| **Forked from** | https://github.com/Challotes/opencook (MIT, © 2026 BSVibes contributors) |
| **Token** | *not yet minted* |
| **Genesis inscription** | *not yet minted* |
| **50% gifted to upstream** | *not yet sent* |

⚠ **These rows are deliberately empty and must stay empty until the transactions exist.** A
convention whose own reference implementation is aspirational is worth nothing, and this file
is the last place to write a cheque the chain has not cashed. Fill each row with a txid when
and only when it is on-chain.

### Which token this is, and which it is not

⚠ **The repository token is NOT a `$Ticker` on openbooks.space.** They are different
instruments that happen to share a `$` prefix, and merging them would break both:

| | the board's `$Ticker` | this repository's token |
|---|---|---|
| what it names | a thread on the board | the repository at its URL |
| units | one per post that named it | a fixed supply, set at issue |
| held by | whoever wrote those posts | parties on a register |
| supply moves when | anyone posts | never |

A board `$Ticker` has **no issuer position at all** — its units belong to whoever wrote the
posts, so there is no half of it to give away. And if repository equity were issued by posting,
every poster would dilute the shareholders: a gifted 50% would start shrinking the moment
somebody typed the name, and an unclaimed holder cannot exercise pre-emption rights they do not
know they have.

So the repository token is issued and recorded elsewhere, and openbooks.space is not involved
in it. Nothing anyone posts on the board can move it.

### The split, decided

| | units | share | |
|---|---:|---:|---|
| **upstream** | 500,000,000 | 50% | gifted, unclaimed until claimed |
| **issuer** | 500,000,000 | 50% | held outright |
| **treasury** | 0 | 0% | none reserved |
| **total** | 1,000,000,000 | 100% | fixed at issue, never increased |

**No separate reserve, deliberately.** A treasury the issuer controls is indistinguishable
from the issuer's own holding — the same key spends both — so splitting the second half into
two labelled buckets would have been a signal rather than a structure. This says the true
thing: half is held, and any grant to a contributor visibly comes out of that half.

⚠ **The cost, stated so nobody rediscovers it as a surprise:** nothing is pre-committed to
future contributors. Every grant is a discretionary transfer from the issuer's own position
rather than a draw against a declared pool, and the pool cannot be created later because supply
is fixed. That is a communication problem and can be answered in words; the supply cannot be
answered in words, which is why it is the number that got decided first.

### What is still open

**An address upstream controls.** Upstream publishes none. This is no longer a blocker: a
position can be recorded against a GitHub login and left unclaimed indefinitely, which requires
nothing of the recipient — not an address, not a signature, not agreement. It only becomes
necessary if the units are to be made transferable to them on-chain.

---

## What we ask of a fork

Nothing enforceable. But if you want the fork recognised here — listed among the tokens this
board indexes, and shown as descended from it — the convention is the price of admission, and
it is checkable rather than promised:

- Mint your repo's token, genesis inscription naming your repository URL.
- Send 50% to the address published by whatever you forked from.
- Add a `FORKS.md` carrying this same convention, so it survives the next fork.
- Put the txids in it.

If you'd rather not, take the code anyway. It's MIT. That is the point of MIT, and we are not
going to pretend otherwise in a file that sits next to it.
