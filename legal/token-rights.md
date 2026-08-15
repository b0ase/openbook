# $OPENBOOK — Token Rights Agreement (DRAFT)

**DRAFT. NOT LEGAL ADVICE. NOT IN FORCE.** Nothing here binds anyone until it is settled by a
lawyer and signed. Every `[TODO]` is a fact only the issuer can supply; every `[LAWYER]` is a
clause that must not ship as written by a non-lawyer.

---

## 1. What the token is

**Token:** `$OPENBOOK`, BSV-21.
**Origin outpoint:** `fad07aff3264701ec1e9fbb778465c07ff8bc1cdaebbc9d7976a48ec07395cd3_0`
**Supply:** 1,000,000,000 units, zero decimals, fixed at issue and incapable of increase.
**Issuer:** [TODO — legal person: Richard Boase personally, or a company once incorporated]
**Subject:** the repository at `https://github.com/b0ase/openbook`.

⚠ **THE TOKEN'S ON-CHAIN RECORD DOES NOT NAME THE REPOSITORY.** The deploy payload is
`{p, op, sym, icon, amt}` and carries no URL. **This agreement is the only thing that binds the
outpoint above to that repository**, which is precisely why the binding is a term rather than an
assumption. A holder who has not signed holds units that nothing connects to anything.

⚠ **The outpoint is the identity, not the ticker.** BSV-21 symbols are not unique; anyone may
deploy a token calling itself `OPENBOOK`. Any reference to "the token" in this agreement means
the outpoint.

---

## 2. What holding the token gives you, absent this agreement

**Nothing.** Stated first because it is the fact most likely to be assumed away.

The units are bearer property: a holder can hold and transfer them, and needs no permission and
no signature to do either. They confer no claim on revenue, no ownership of the repository, no
governance right, no information right and no obligation on the issuer of any kind.

This is not a temporary state pending some later document. It is what an unwrapped token is.

---

## 3. What this agreement confers on a signatory

Rights arise **only** for a holder who has signed, and only while they hold.

**3.1 Revenue share.** [TODO — the number] per cent of [TODO — DEFINE THE BASE: gross revenue of
the platform? net profit? revenue attributable to the repository? each is a different promise and
they are not interchangeable] distributed pro rata across signed holders by units held.

**3.2 Payment mechanics.** Distributions [TODO — frequency] to a BSV address nominated by the
holder. [LAWYER — withholding, tax residence, and what happens when a distribution is smaller
than the cost of sending it.]

**3.3 Information.** Signed holders receive [TODO — what, how often]. Without this, "revenue
share" is unverifiable by the person entitled to it.

**3.4 What is NOT conferred.** No equity in any company, no seat, no vote, no veto, no
consent right over the repository's direction, licence, sale or closure. The issuer may
close-source future work, relicense future work, or stop the project entirely.

---

## 4. Transfer — the clause that decides whether this instrument works

⚠ **UNRESOLVED. This is the central design question and it must be answered before signature,
not after.** The token is transferable on-chain and cannot be made otherwise. So:

**Option A — rights run with the token.** A buyer gets the rights automatically. Clean, liquid,
and it means the token is genuinely worth something to someone who never signed — which
undercuts the whole "sign or it is meaningless" position.

**Option B — rights attach to the signatory only.** A buyer holds bare units until they sign a
deed of adherence. Preserves the position, but the token trades at a discount to its rights and
every transfer needs the issuer's paperwork.

**Option C — rights run with the token, but only to a holder who has signed.** The middle: the
right is attached to the units, dormant in unsigned hands, active on adherence.

[LAWYER — this determines whether the instrument is a contract right, a transferable security,
or something in between, and that classification has consequences the issuer cannot choose.]

---

## 5. Issuer covenants

**5.1 No further issue.** The supply cannot be increased — a property of BSV-21, not a promise
that can be broken.

**5.2 No supersession.** The issuer will not issue a later token representing the same
repository. ⚠ Recorded because the clause reserving that right was drafted and deliberately cut:
a token its issuer may replace at will does not represent the thing it names.

**5.3 No dilution of the gifted portion.** [TODO — confirm scope.]

---

## 6. The upstream gift

500,000,000 units (50%) are allocated to the authors of
`https://github.com/Challotes/opencook`, the repository this one was forked from.

The gift is unconditional and requires nothing of them: no signature, no acceptance, no
counterparty. **It is not settlement of a debt** — upstream never published a fork term, and an
unpublished term is not a default.

⚠ The rights in section 3 do not follow the gift. They require signature like anyone else's.
The gift transfers property; this agreement transfers rights; they are separate acts and a
recipient may take the first and decline the second indefinitely.

---

## 7. Boilerplate

[LAWYER] Governing law [TODO — jurisdiction]. Dispute resolution. Termination. Assignment.
Entire agreement. Severability. Notices. Limitation of liability. Warranty disclaimer — in
particular that the issuer warrants nothing about the value, liquidity, tax treatment or
regulatory classification of the units.

---

## Open questions for the issuer, before a lawyer is worth paying

1. **Section 3.1's base.** "Rights on profits" is not yet a number or a defined quantity.
2. **Section 4.** A, B or C. Everything else is detail by comparison.
3. **Who is the issuer** — a person or a company. Section 3.4 says no equity; if a company is
   later formed and the intent is that holders participate in it, this document is the wrong
   instrument and a subscription agreement is the right one.
4. **Whether unsigned holders are ever told.** A person can hold these units for years without
   knowing rights were available. Silence is defensible; it should be a choice.
