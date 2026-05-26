# DEGEN SWARM DEMO — ELI5

> Dark Null turns chain garbage into paid jobs.

## What is this?

The **Degen Swarm Economy** is a set of 12 on-chain primitives that turn protocol maintenance into paid work, privacy cover, and reputation.

---

## ELI5 Explainers

**You can earn by cleaning expired ghosts.**
Solana accounts that have expired (scratch slots, chaff accounts, empty token accounts) still hold rent.
A keeper — anyone with a bot — can close them and earn a bounty from the reclaimed lamports.
The Rent Sweeper Swarm crate finds these targets and builds a sweep plan.

**You can save by routing through colder writable accounts.**
Every Solana transaction needs writable accounts. Hot accounts (used by everyone) inflate priority fees.
The Cold Route Fee Sniper finds routes through less-contested writable accounts, saves you lamports,
and gives Dark Null a cut of the savings. No one needs to know which accounts you chose.

**Chaff is not spam; it does work.**
Useful Chaff Market jobs require the chaff transaction to do real on-chain maintenance:
compact a Merkle root, rotate an epoch, heal a shard. Zero-maintenance-value chaff is rejected.
You earn a reward proportional to the maintenance value and the privacy cover you provide.

**Bounties can be clicked through Blinks.**
Bounty Blink Jobs wrap keeper tasks as Solana Actions (Blinks) — a URL you can click in a wallet.
The job has a proof gate: you only earn the reward if you submit the correct proof hash.
No raw URLs, no secrets in titles, no custody of funds until completion.

**Puzzle jobs mine words into Solana state.**
Ritual Puzzle Market lets anyone post a message hash and a reward.
A solver who can produce the correct solution commitment (SHA256 of the commitment scheme) earns the reward.
The message itself is never stored on-chain — only its hash. CASH was the first word mined.

---

## Primitives at a glance

| Crate | What it does |
|---|---|
| `rent-sweeper-swarm` | Find and sweep expired accounts for bounties |
| `bounty-blink-jobs` | Keeper tasks as clickable Blinks |
| `cold-route-fee-sniper` | Choose cheapest writable-account routes |
| `no-deploy-token-launcher` | Token-2022 launch plans, no custom program needed |
| `scratch-slot-leasing` | Reuse protocol scratch slots, save rent |
| `shape-pool-pass` | Paid membership in transaction-shape anonymity pools |
| `useful-chaff-market` | Chaff that earns by doing maintenance |
| `copy-sniper-trap-board` | Detect alpha copy-snipers with poison leaves |
| `ritual-puzzle-market` | Mine words into state via puzzle bounties |
| `fee-cashback-receipts` | Verifiable proof of fee savings |
| `sleep-earn-watcher` | Local bot config and job filtering |
| `degen-scoreboard` | Reputation from protocol work, not speculation |

---

## Constraints

- `mainnet_ready: false` — all primitives are devnet/demo only
- `production_claim: false` — no audit, no mainnet keys
- No raw private keys in any JSON output
- Every crate has at least 5 tests

---

*NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.*
