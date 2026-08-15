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

## Why this is not in the licence

We considered writing it into the licence and decided against it, for reasons worth recording
so nobody re-opens the question casually:

- **We can't licence what we don't own.** This repository is itself a fork of MIT-licensed
  [OpenCook](https://github.com/Challotes/opencook). Upstream's grant flows through us
  irrevocably; conditions we add could only ever bind our own additions, and anyone can take
  the upstream code without us in the picture at all.

- **"Send 50% of your tokens" is not a definable obligation.** Mint two tokens, send one,
  comply completely, deliver nothing. Closing that hole means specifying supply, structure and
  valuation inside a licence, and every clause added is another thing to argue about.

- **It would not be enforceable in practice.** You cannot detect a private fork, and suing a
  public one costs more than the tokens are worth.

- **It would cost real adoption.** A licence with a payment condition is not open source by any
  standard definition. Much corporate legal review rejects those automatically.

So: MIT, plus a norm with a public ledger behind it. A licence tells people what is forbidden
and needs a court. A public record tells people what everyone else did and needs an audience.
This project is already built to be the second thing.

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

Two things must be settled before that is possible, and both are open:

1. **An address upstream controls.** Upstream's author commits as `Nige <>` with no published
   address. Tokens "gifted" to an address we control are an intention, not a gift. Until one is
   published, the honest form is to mint, declare the offer publicly with the txid, and hold
   the units unspent and unclaimed.

2. **An issuer allocation.** A `$Ticker` on this board currently has no issuer position at all:
   its units are one per post that named it, held by whoever wrote those posts. **You cannot
   gift half of a supply you do not hold.** Making the gift possible means first deciding
   whether minting a name creates an issuer position, and saying so before anyone claims
   another name — not afterwards, which is the version that reads badly.

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
