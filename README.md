# OpenBook

**A platform that builds itself, then lets anyone do the same.**

Post an idea. It gets logged on-chain. A fairness system watches who contributed what. When someone pays to spotlight a post, that payment splits instantly across every contributor — in a single transaction, directly to their address, with every sat accounted for in an OP_RETURN audit trail on BSV.

That's the whole thing. Everything else is iteration.

---

## Why it matters

Most platforms extract value from contributors and keep it, distributing returns only to shareholders or the founding team.

The person in Lagos with a brilliant idea but no money for a patent earns the same as the ex-Google architect. The teenager with vibes earns the same as the expert with credentials. An anonymous user posting as `anon_k` gets the same credit as anyone else.

**OpenBook doesn't care who you are. It cares what you did.**

On-chain timestamps are the arbiter. Who posted first is a fact, not an opinion. You show up, contribute, and the system tracks it permanently — across key rotations, across forks, across whatever projects get built on top.

---

## How it works

1. You visit the site. A BSV keypair generates silently in the background.
2. You type an idea and post. It's signed with your key and logged on-chain.
3. Someone boots (pays to spotlight) a post they believe in.
4. That payment splits across all contributors by weight, in a single BSV transaction, directly to their addresses.
5. Every sat goes out in that same transaction. The server never holds your money.

The fairness formula (Phase 1): contribution weight = `sqrt(engagement) × time_decay`. This is the working proof of concept — it will evolve as real contributions (code, design, community building) are tracked. Tunable by the AI agent as the platform matures. Everything is verifiable on-chain.

---

## What's built today

- Posts signed with ECDSA, logged via OP_RETURN, verifiable on WhatsOnChain
- Real-time feed polling with incremental updates
- Bootboard: pay-to-spotlight with live timer and automatic contributor split
- Trustless split payments: browser builds the transaction, broadcasts directly to contributors
- 15 free boots per user, then self-funded via BSV balance
- AI agent chat (Claude) with full project context, streaming responses
- Zero-friction identity: keypair auto-generated, AES-256-GCM optional passphrase encryption (encrypt-in-place — the key/address never changes)
- Contribution scoring with decay and engagement multiplier
- Earnings sparkline, noob/goat currency toggle ($ vs sats), live balance polling
- Self-contained HTML recovery files that work offline with no server required

---

## Quick start

**Requires Node 20+** (Next.js 16 + React 19.2 + Turbopack).

```bash
git clone https://github.com/b0ase/openbook
cd openbook
npm install
cp .env.example .env.local
npm run dev
```

Everything works out of the box with zero keys. The two optional ones:

```env
# AI agent chat (optional — get one at console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-...

# On-chain post logging (optional — generate with: node scripts/generate-wallet.mjs)
BSV_SERVER_WIF=L1...
```

Without any keys, posts save to local SQLite and boots split payments normally. Add `BSV_SERVER_WIF` and every post gets an OP_RETURN fingerprint you can verify on WhatsOnChain. Add `ANTHROPIC_API_KEY` and the AI chat agent comes alive with full awareness of the project's direction, decisions, and codebase.

---

## AI-native repo

When you clone this repo, your AI assistant has full context immediately:

- `CLAUDE.md` — architecture, key files, coding standards, the full picture
- `DIRECTION.md` — where this is going and why
- `DECISIONS.md` — decisions already made (don't relitigate them)
- `FAIRNESS.md` — the revenue model, formula, gaming analysis
- `ROADMAP.md` — what's done, what's next
- `FUTURE.md` — ideas and explorations

AI agents are instructed to update these files as they work, so the documentation stays accurate without a separate maintenance pass. Fork it, improve it, ship it — the context comes with the code.

---

## The prior art angle

We could have patented this. The Agentic Fairness Protocol, the trustless split payments, the zero-friction identity with on-chain key migration — these are genuinely novel combinations. Independent prior art research confirmed it.

We put them on-chain instead. By publishing on-chain, we created prior art that blocks future patents on these ideas — the timestamps are permanent, publicly verifiable on BSV, and owned by everyone who contributed to building them.

Do you get it, anon? The system is the publication. The chain is the record.

---

## The recursive model

Once the model is proven here, any post can spawn its own platform. Same contribution tracking, same fairness system, same on-chain history, same rules the founder can tune from day one. The project owner sets their parameters, their community becomes their first contributors, and revenue flows automatically from the first boot.

OpenBook is the first proof that this works — the seed planted before anyone else uses the model.

---

## Deeper reading

- [DIRECTION.md](DIRECTION.md) — the north star, who this is for, where it's going
- [FAIRNESS.md](FAIRNESS.md) — the full revenue model, formula, gaming analysis, phase progression
- [FUTURE.md](FUTURE.md) — ideas the code is quietly becoming
- [ROADMAP.md](ROADMAP.md) — what's done, what's next

---

## License

MIT — see [LICENSE](LICENSE).

$OpenBooks is a fork of [OpenCook](https://github.com/Challotes/opencook), which is MIT
licensed and copyright © 2026 BSVibes contributors. MIT asks that the copyright notice and
the permission notice travel with the code, so the upstream notice is kept in `LICENSE`
alongside this project's own. Posts 1–2023 in the feed came from upstream and are signed by
their original authors — see `src/lib/fork-point.ts` and [DIRECTION.md](DIRECTION.md), which
distinguishes upstream's positions from this fork's throughout.
