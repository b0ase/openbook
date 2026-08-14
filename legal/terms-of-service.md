<!-- DRAFT — not legal advice — [LAWYER] review required before launch. -->

# OpenBook — Terms of Service (DRAFT)

> **This is a working draft for attorney review. It is not legal advice and is not yet in force.**
> Effective date: **[TODO: EFFECTIVE DATE]**

---

## 1. Acceptance & Eligibility

By accessing or using OpenBook (the "Service"), you agree to these Terms of Service ("Terms"). If you do not agree, do not use the Service.

You must be at least **[TODO: MIN AGE]** years old to use the Service. By using the Service you represent that you meet this minimum age and that you have the legal capacity to enter into these Terms.

`[LAWYER: Set the minimum age and confirm the framework. If targeting/processing data of minors is possible, address COPPA (US, under-13) and GDPR Article 8 (EU, default age-of-consent 16, lowerable to 13 by member state). An anonymous no-signup board cannot meaningfully age-gate — assess whether an age attestation is sufficient or whether stronger measures are required. See also Section 12 and the Privacy Policy "Children's data" section.]`

## 2. What the Service Is

OpenBook is an **experimental, beta** anonymous public message board. It is provided for early testing and may change, break, or be discontinued at any time.

When you submit a post, the Service records it **on the BSV blockchain** as an `OP_RETURN` output. The post content, your public key/address, your cryptographic signature, and a timestamp are written to a public, distributed ledger. The Service also stores a copy in its own database to render the app feed.

The Service does not require an email address, phone number, real name, or account signup. Your identity is a cryptographic keypair generated in your browser (see Section 4).

## 3. PERMANENCE & PUBLICATION — READ THIS CAREFULLY

**This is the most important section of these Terms.**

- **Every post you make is permanent and public.** When you post, your content is broadcast to the BSV blockchain and becomes part of a public, distributed, append-only ledger.
- **Your posts are readable by anyone, forever.** Anyone in the world — not just OpenBook users — can read on-chain data using public block explorers and other tools.
- **The operator cannot delete, edit, or recall your posts from the blockchain.** Once a post is broadcast, it is out of the operator's control. No one — not the operator, not you — can remove it from the chain.
- **Third parties replicate and index the chain.** Independent nodes, explorers, archives, and indexers copy and re-publish on-chain data. Even if OpenBook stops showing a post in its own feed, those third parties may continue to display it.
- **Do not post personal data or anything you may later want removed.** Do not post your real name, address, contact details, anyone else's personal data, secrets, or anything sensitive. Treat everything you post as a permanent public broadcast.

`[LAWYER: This section is the linchpin of the immutability-vs-erasure tension. Confirm the disclosure is sufficient to establish informed assumption of risk, and that it is consistent with the Privacy Policy's GDPR/CCPA erasure-limit language. The operator literally cannot honor an on-chain erasure request — this needs to be airtight and consistent across all three documents and the pre-first-post gate.]`

## 4. Identity, Keys & NO RECOVERY

- Your identity is a **BSV keypair generated in your browser** and stored on your device. The operator does not hold your private key and never has custody of it.
- **If you lose your recovery file or forget your passphrase, your identity is permanently lost** — along with any value (funds) associated with it.
- **The operator cannot restore, reset, or recover your key, your identity, or your funds.** There is no "forgot password," no support reset, no backup held by the operator.
- You are solely responsible for backing up and securing your recovery file and passphrase.

## 5. Your Responsibility for Content

**You are the publisher of everything you post.** You — not the operator — author the content and cause it to be broadcast.

By posting, you represent that you have the right to publish the content and that doing so does not violate any law or any third party's rights. **You assume the full risk of permanent, public, irreversible publication.**

## 6. Prohibited Content

You must not post, attempt to post, or use the Service to facilitate:

- **Illegal content** of any kind under applicable law.
- **Child sexual abuse material (CSAM) or any child sexual exploitation content.** This is absolutely prohibited. Do not create, share, link to, or solicit it in any form.
- **Intellectual-property infringement** — content that infringes copyright, trademark, or other IP rights.
- **Doxxing or others' personal data** — publishing another person's private or identifying information.
- **Threats, harassment, or incitement** — threats of violence, targeted harassment, or incitement to harm.
- **Malware** — malicious code, links, or payloads.
- **Fraud or scams** — deceptive, fraudulent, or manipulative schemes.

Prohibited content **may be screened by an automated filter before publication** and the operator **may decline to broadcast or display** any content at its discretion. See Section 7 for what this filtering can and cannot do.

`[LAWYER: CSAM / illegal-content exposure is materially elevated here because the OPERATOR'S server broadcasts the OP_RETURN to the blockchain. The operator is acting as a publisher of the data it broadcasts, not a passive host of third-party content. US Section 230 does not shield CSAM (18 U.S.C. § 2258A reporting obligations to NCMEC may apply), and "publisher" characterization may defeat 230 immunity more broadly. Assess: NCMEC/CyberTipline reporting duties, the operator's exposure as broadcaster, the adequacy of the pre-publication filter as a defense, mandatory-reporting obligations, and whether broadcasting user content as the operator's own transaction changes the liability analysis vs. a passive UGC host. This is the single highest-risk item in this document.]`

## 7. Moderation — What Exists and What Does Not

The operator's moderation is limited and best-effort. Specifically:

- **Pre-publication filter (best-effort).** Before a post is broadcast, the Service runs an automated, best-effort screen for clearly illegal content. **This filter is not comprehensive and will miss things.** It is not a guarantee, and it does not constitute review of every post.
- **Declining to display / hiding from the feed.** The operator may decline to broadcast a post, or may **hide a post from the OpenBook app feed** so that it is no longer shown within the app.

**What moderation CANNOT do:** Hiding a post from the OpenBook feed does **not** remove it from the blockchain. On-chain data is permanent. A hidden post is simply **no longer shown in the OpenBook app** — it remains on-chain and may still be visible through other explorers and tools. The operator cannot delete, erase, or take down on-chain content.

`[LAWYER: Confirm the moderation description does not over-promise a capability the operator does not have, and does not inadvertently create a duty (e.g., a representation of comprehensive screening) the operator cannot meet. The "best-effort, not comprehensive" framing is intentional — verify it is defensible and consistent with the CSAM/illegal-content analysis in Section 6.]`

## 8. Payments & Boosts — NO CUSTODY

The Service supports peer-to-peer micro-payments ("boosts" or "boots").

- **The transaction is the payment.** A boost is a BSV blockchain transaction built and broadcast **client-side, in your browser**. Value moves directly between participants on-chain.
- **The operator never holds, controls, or has custody of your funds.** The operator does not act as an intermediary, escrow, or wallet provider for boost funds.
- **No refunds. On-chain transactions are irreversible.** Once broadcast, a boost cannot be reversed, cancelled, or refunded by anyone.
- **Boosts are not investments.** A boost is a payment, not a security, share, or investment. There is no expectation of profit, return, dividend, or appreciation, and none is offered or implied.

`[LAWYER: Money-transmitter / MSB characterization needs a full assessment. Although boosts are built and broadcast client-side with no operator custody, two features complicate the no-custody story: (1) the operator funds certain "free" boosts from an operator-controlled server wallet (an operator-paid subsidy that moves operator value to third parties), and (2) the operator takes a platform fee (described as ~5% in product materials — confirm exact figure and how it is collected). Assess FinCEN MSB/money-transmission status, state money-transmitter licensing, and any analogous obligations in the governing jurisdiction. The operator-funded subsidy and the fee are the facts most likely to undercut a "we never touch funds" position — analyze them specifically.]`

## 9. No Warranty — Service Provided "AS IS"

The Service is provided **"AS IS" and "AS AVAILABLE," without warranties of any kind**, express or implied, including (without limitation) merchantability, fitness for a particular purpose, non-infringement, availability, accuracy, or uninterrupted or error-free operation.

`[LAWYER: Confirm the warranty disclaimer is enforceable in the governing jurisdiction, that required statutory consumer warranties are not improperly disclaimed, and that the all-caps/conspicuousness requirements (e.g., UCC § 2-316 in the US) are met.]`

## 10. Assumption of Risk & Limitation of Liability

You acknowledge that the Service involves **experimental software, irreversible on-chain publication, irreversible payments, and self-custodied keys**, and you **assume all risk** of using it.

To the maximum extent permitted by law, the operator and its affiliates will not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of data, identity, funds, or value, arising out of or relating to the Service. To the maximum extent permitted by law, the operator's total aggregate liability is limited to **[TODO: LIABILITY CAP AMOUNT]**.

`[LAWYER: Set the liability cap and confirm enforceability of the cap and exclusions in the governing jurisdiction. Note that consequential-damages exclusions and caps are restricted or unenforceable in some jurisdictions and for certain claims (e.g., gross negligence, willful misconduct, statutory consumer rights). Coordinate with Section 9.]`

## 11. Indemnification

You agree to indemnify and hold harmless the operator and its affiliates from and against any claims, losses, liabilities, and expenses (including reasonable legal fees) arising out of or related to your content, your use of the Service, or your breach of these Terms.

`[LAWYER: Confirm scope and enforceability of the indemnity, including any consumer-context limitations in the governing jurisdiction.]`

## 12. Changes & Termination

- The operator may modify or discontinue the Service, and may update these Terms, at any time. Continued use after changes take effect constitutes acceptance.
- **The operator may terminate or restrict your access to the OpenBook app** at any time.
- **The operator CANNOT terminate your on-chain presence.** Posts already broadcast to the blockchain remain on-chain permanently, regardless of any termination of app access. Termination removes access to the app — it does not remove anything from the chain.

## 13. Governing Law, Disputes & Severability

These Terms are governed by the laws of **[TODO: JURISDICTION / GOVERNING LAW]**, without regard to conflict-of-laws principles. Any disputes will be resolved in the courts (or other forum) of that jurisdiction.

If any provision of these Terms is found unenforceable, the remaining provisions remain in full force and effect.

`[LAWYER: Set governing law, venue, and dispute-resolution mechanism (court vs. arbitration; class-action waiver?). Confirm enforceability against anonymous, potentially-global, possibly-consumer users. Note that mandatory consumer-protection regimes (e.g., EU) may override a chosen governing law for users in those jurisdictions.]`

## 14. Contact

Questions about these Terms: **[TODO: CONTACT EMAIL]**.

Operator: **[TODO: OPERATOR LEGAL NAME]**.

`[LAWYER: Advise whether the operator should form a limited-liability entity before launch. Operating an anonymous on-chain board that broadcasts user content (with the CSAM/illegal-content and money-transmitter exposure above) as an individual sole proprietor may expose the individual to unlimited personal liability. Entity formation and the resulting governing-law/venue choices should be settled before these Terms go live.]`
