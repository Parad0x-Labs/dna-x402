# NULL Miner — Isolated Research Lab

> **Scope:** Research + integration spec only. No production code. Local only.  
> **Author:** Claude Sonnet (via Parad0x Labs brainstorm session, 2026-05-28)  
> **Status:** Pre-build research — do not merge to main

---

## What is this folder?

Isolated research workspace for the **NULL Mining Network** concept —
a DePIN-style network where phones and laptops run automated tasks,
earn NULL tokens as mining rewards, and the protocol earns USDC per
task via x402 micropayments.

**This is not a new project.** ~70% of the required infrastructure
already exists inside this monorepo. This folder maps exactly what
exists, what's missing, and how to connect them.

---

## Files in this folder

| File | Contents |
|---|---|
| `CONCEPT.md` | Full concept spec — what it is, why it's novel, who the users are |
| `COMPETITIVE_PROOF.md` | Evidence that this hasn't been built — gap analysis vs. Grass, io.net, AgenC, Phala, Olas |
| `STACK_INTEGRATION.md` | Exact crate-by-crate mapping of existing DNA x402 primitives to NULL Miner roles |
| `GAP_ANALYSIS.md` | The 4 missing pieces between current state and a launchable MVP |
| `TOKENOMICS.md` | NULL emission model — how to extend the Flywheel Vault to task completions |

---

## TL;DR in one paragraph

Your phone hosts a **Dark Agent** (with its own Passport, stealth address, ZK reputation).
The agent autonomously scans the `bounty-blink-jobs` / `useful-chaff-market` task market,
claims tasks via the `dark-agent-escrow` reverse escrow, completes them, and submits a
`dark-compute-receipt` as proof. The `dark-agent-passport` accumulates reputation.
The `null-flywheel-core` mints NULL tokens to the hosting phone as yield.
Enterprise task posters pay USDC per task via x402. **The phone owner earns NULL for
uptime + residential IP. They never touch the tasks themselves.**

No DePIN project has this architecture. The closest (AgenC on Solana) does the
pull-based escrow mechanic but has zero privacy layer and no host-yield token.
Grass has the phone DePIN + revenue but uses centralized payout and dumb nodes
(just bandwidth relay, no autonomous agent identity).
