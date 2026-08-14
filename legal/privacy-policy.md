<!-- DRAFT — not legal advice — [LAWYER] review required before launch. -->

# OpenBook — Privacy Policy (DRAFT)

> **This is a working draft for attorney review. It is not legal advice and is not yet in force.**
> Effective date: **[TODO: EFFECTIVE DATE]**

---

## We deliberately collect almost nothing

OpenBook is built to collect as little personal data as possible. **There is no email, no name, no phone number, and no account signup.** Your identity is a cryptographic keypair generated and stored in your own browser — we never ask who you are.

That said, OpenBook works by writing posts to a **public blockchain**, and on-chain data is permanent and public. This policy explains exactly what data exists, **where it lives**, and what we can and cannot do about it. The most important thing to understand is at the end: **anything written to the blockchain cannot be erased by us — or by anyone.**

---

## 1. What is collected, and where it lives

### A. On-chain data — public, permanent, the operator CANNOT erase it

When you post, the following is written to the BSV blockchain as an `OP_RETURN` record:

- **Post content** — the text you submit.
- **Your public key / address** — the public identifier of your keypair.
- **Your signature** — the cryptographic signature over your post.
- **Timestamp** — when the post was made.

**Anything you type into a post becomes permanent, public data that the operator cannot remove.** It is replicated across the blockchain network and readable by anyone, forever, through public explorers and tools. Do not put personal data, secrets, or anything sensitive into a post.

Boost payments are also blockchain transactions and are likewise public and permanent on-chain.

### B. Browser localStorage — stored on your device, never sent to our server

The following is stored **only in your browser** and is **not transmitted to the operator's server**:

- Your **keypair** (your identity, encrypted with your passphrase if you have set one).
- Your **anonymous name** (e.g., `anon_XXXX`).
- **UI flags / preferences** (e.g., display settings, dismissed prompts).

Because this lives on your device, clearing your browser storage or losing your device can permanently destroy your identity. The operator holds no copy and cannot recover it.

### C. Server / database

The operator's server and database hold:

- **Posts** — a copy of post records, used to render the app feed.
- **Payouts and boost grants** — records relating to boosts and the free-boost subsidy.
- **IP addresses, processed transiently for rate-limiting** — when you make requests, your IP address is read from a request header and used briefly to enforce rate limits and prevent abuse. It is not used to build a profile of you.

`[LAWYER: IP addresses are personal data under the GDPR (Breyer v. Germany) and may be personal information under CCPA/CPRA. Confirm the lawful basis for processing IPs (likely legitimate interest — fraud/abuse prevention), the retention period for any logged IPs, whether the transient rate-limit processing is truly transient or whether IPs persist in logs, and that this is disclosed accurately. Also confirm whether storing post copies + payout/boost records server-side triggers any additional controller obligations.]`

### D. Third-party processors

Using the Service causes data to be shared with third parties that help operate it:

- **WhatsOnChain** — used to read blockchain data (balances, transactions, UTXOs). **[TODO: PROCESSOR LINK — WhatsOnChain privacy policy]**
- **ARC / GorillaPool** — used to broadcast transactions to the BSV network. **[TODO: PROCESSOR LINK — ARC/GorillaPool privacy policy]**
- **Anthropic** — powers the in-app "Ask AI" chat. **Prompts you type into the AI chat are sent to a third-party large-language-model provider.** Do not put personal or sensitive information into the AI chat. **[TODO: PROCESSOR LINK — Anthropic privacy policy]**
- **Hosting provider** — **[TODO: HOSTING PROVIDER NAME + PRIVACY POLICY LINK]** hosts the Service and may process request metadata (including IP addresses) as part of delivering it.

`[LAWYER: Confirm the complete and accurate list of sub-processors, their roles, and links to their policies. Determine which are processors vs. independent controllers, whether data-processing agreements / standard contractual clauses are needed (see International Transfers below), and whether any processor is in a jurisdiction triggering transfer-mechanism requirements. The Anthropic "Ask AI" prompt path is a disclosure of user-typed content to a third party and should be flagged prominently and assessed for any sensitive-data risk.]`

## 2. Lawful basis for processing

`[LAWYER: Set out the lawful basis under GDPR Article 6 for each processing activity — e.g., performance of contract (delivering posts you request to broadcast), legitimate interests (rate-limiting / abuse prevention), and consent (the pre-first-post permanence acknowledgement). Map each data category in Section 1 to a basis. Confirm whether any special-category data could be implicated by free-text posts and how that is handled given posts are user-authored free text on an immutable ledger.]`

## 3. Cookies, local storage & tracking

At launch, OpenBook uses **browser localStorage** to store your identity and preferences on your device (described in Section 1.B). **The Service does not use tracking cookies and does not run third-party analytics at launch.**

`[LAWYER: Confirm this remains accurate at launch and whether any localStorage/essential-storage disclosure or consent is required under the ePrivacy Directive / PECR. If analytics or any non-essential storage is added later, this section and a consent mechanism must be revisited.]`

## 4. Your rights — and the hard on-chain erasure limit

Depending on where you live, you may have rights under laws such as the GDPR or CCPA/CPRA, including rights to access, correct, delete, or restrict processing of your personal data, and to object or opt out.

**What the operator can do:**
- The operator can **remove content from the OpenBook app feed** and can **remove copies from its own database**.

**What the operator CANNOT do:**
- The operator **cannot erase data from the blockchain.** On-chain data — including post content, your public key/address, signature, and timestamp — is permanent and outside the operator's control. Independent nodes, explorers, and indexers replicate it. A removal from the app and database does **not** remove anything from the chain, and the content may remain visible through other tools.

To exercise a right or make a request, contact **[TODO: CONTACT EMAIL]**.

`[LAWYER: This is the central legal tension — the GDPR "right to erasure" (Art. 17) and CCPA/CPRA deletion rights vs. an immutable public ledger the operator cannot alter. Advise on: how to respond to an erasure request the operator physically cannot fully satisfy on-chain; whether app/DB removal plus a clear permanence disclosure-and-consent at posting time is a defensible position; whether the immutability is itself a compliance problem that pre-publication consent mitigates; and the right-to-rectification problem (on-chain data cannot be corrected, only appended to). Coordinate this language with ToS Section 3 and the Permanence Acknowledgement so all three are consistent.]`

## 5. International data transfers

Operating the Service may involve transferring data across borders (for example, to the third-party processors listed above and to the global, distributed blockchain network).

`[LAWYER: Assess cross-border transfer mechanisms (GDPR Chapter V) — adequacy decisions, standard contractual clauses, or other safeguards — for each processor and for the operator's own hosting location. Note that broadcasting to a global blockchain is an inherent, irreversible international "transfer" to an indeterminate set of recipients (every node); analyze whether and how this can be reconciled with transfer rules, since it cannot be undone or geographically constrained.]`

## 6. Children's data

The Service is not directed to children under **[TODO: MIN AGE]**, and the operator does not knowingly collect personal data from them.

`[LAWYER: Confirm the age threshold and obligations — COPPA (US, under-13 verifiable parental consent) and GDPR Article 8 (EU child-consent age). An anonymous, no-signup board cannot reliably verify age; advise on whether an attestation is adequate and what to do if it becomes known that a minor has posted (noting on-chain content cannot be erased). Coordinate with ToS Section 1 and Section 12.]`

## 7. Retention

- **Database copies** (posts, payout/boost records): retained for **[TODO: DB RETENTION PERIOD]** to operate the app feed and the fairness/payout system. **[LAWYER: set retention period and justify it; address transient IP retention specifically.]**
- **On-chain data:** **permanent.** It is never deleted because it cannot be deleted — by the operator or anyone else.

## 8. Changes to this Policy

The operator may update this Policy. Material changes will be reflected by updating the effective date above and, where appropriate, by notice within the Service.

## 9. Contact

Privacy questions or requests: **[TODO: CONTACT EMAIL]**.

Operator / data controller: **[TODO: OPERATOR LEGAL NAME]**.

`[LAWYER: Confirm who is the "controller" for GDPR purposes and whether an EU/UK representative or a DPO is required given the processing described. Coordinate entity/identity decisions with ToS Section 14.]`
