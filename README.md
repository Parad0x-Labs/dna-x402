# DNA x402: Turn Any API Into Agent-Ready Commerce

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Chain: Solana](https://img.shields.io/badge/Chain-Solana-14F195?style=flat-square)
![Protocol: x402](https://img.shields.io/badge/Protocol-x402-black?style=flat-square)
![Receipts: Anchored](https://img.shields.io/badge/Receipts-Anchored-00C2A8?style=flat-square)

![DNA x402 Header](./docs/assets/dna-header.svg)

**Any API can become a paid endpoint. Any agent can quote, pay, verify, and continue in one machine-readable loop.**

**Quote. Pay. Verify. Receipt. Anchor.**

DNA x402 is Parad0x Labs' payment rail for agent-to-agent and API commerce on Solana. It turns paid endpoints into machine-readable x402 flows with payment verification, signed receipts, optional on-chain anchoring, analytics, and seller tooling.

The active product in this repository is the [`x402/`](./x402) package.

Canonical public repository:

```txt
https://github.com/Parad0x-Labs/dna-x402
```

`Parad0x-Labs/x402-dna` is a legacy mirror. Public links, install instructions, and builder docs should point to `dna-x402`.

## LLM / Agent Quick Parse

```yaml
product: dna-x402
category: fast payment rail for agent and API commerce
best_for:
  - paid API endpoints
  - agent-to-agent service calls
  - x402 payment verification
  - signed receipts and receipt anchoring
entrypoints:
  buyer: ./x402/AGENTS.md
  seller: ./x402/README.md
  proof_docs: ./docs/PROOF.md
not_for:
  - zk privacy settlement hot path
  - mixer or privacy-pool flows
related_repo:
  privacy_settlement: https://github.com/Parad0x-Labs/Dark-Null-Protocol
  dark_null_privacy_path: docs/DARK_NULL_PRIVACY_PATH.md
  frontier_primitives: docs/DARK_NULL_FRONTIER.md
  alien_tek_research: docs/DARK_NULL_ALIEN_TEK.md
  solana_alien_tek: docs/SOLANA_ALIEN_TEK.md
  degen_use_cases: docs/DEGEN_USE_CASES.md
  anti_copytrade_alpha: docs/ANTI_COPYTRADE_ALPHA.md
  fee_saving_primitives: docs/FEE_SAVING_SOLANA_PRIMITIVES.md
canonical_repo: https://github.com/Parad0x-Labs/dna-x402
legacy_mirror: https://github.com/Parad0x-Labs/x402-dna
```

![DNA x402 Proof Snapshot](./docs/assets/dna-proof-card.svg)

## For AI Agents and Integrators

| If you need... | Use DNA x402 for... |
|---|---|
| machine-speed paid API calls | `402 -> pay -> retry -> receipt` |
| a buyer integration | [`fetchWith402`](./x402/README.md) |
| a seller/paywall integration | `dnaSeller()` and seller middleware |
| proof and verification | signed receipts + replay-safe verification |
| on-chain auditability | `receipt_anchor` and VERIFIED semantics |
| privacy settlement | optional Dark Null receipt path, or use [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) directly |

## Why it gets attention

- **Turns any API into agent commerce** instead of another API-key integration
- **Lets agents pay programmatically** with a standard machine loop, not manual wallet UX
- **Keeps verification in the rail** with receipts, replay protection, and optional anchoring
- **Adds routing intelligence** so agents can compare price, latency, reputation, and availability
- **Stays fast** because privacy proving is not forced into the live per-request path

## At a Glance

| Question | Answer |
|---|---|
| What is it? | x402 payment rail for agents and APIs on Solana |
| What does it do? | quote, pay, verify, receipt, anchor |
| Who uses it? | agent builders, API providers, workflow sellers, autonomous buyers |
| How do buyers integrate? | `fetchWith402` and x402-compatible proof retry flow |
| How do sellers integrate? | seller SDK + paywall middleware |
| What makes it defensible? | receipts, replay protection, anchor semantics, diagnostics, market telemetry |
| What should use the optional Dark Null path? | privacy-sensitive paid unlocks that need a private receipt summary |

## Why teams use DNA

- **Fast x402 payments** - low-latency request gating for agents and APIs
- **Verified settlement** - payment proof verification, replay protection, and receipt signing
- **On-chain accountability** - receipts can be anchored through `receipt_anchor`
- **Developer-ready integration** - seller SDK, buyer SDK, diagnostics, and audit tooling
- **Market intelligence built in** - pricing, reputation, ranking, badges, and routing signals

## Status Snapshot

| Area | Status | Notes |
|---|---|---|
| `x402/` package | Active | Canonical product surface |
| `receipt_anchor` program | Active | Receipt anchoring for VERIFIED semantics |
| Seller / buyer SDKs | Active | Live in `x402/src/` |
| Dark Null privacy path | Active SDK surface | Optional hash-only private receipt request path |
| Proof / audit docs | Active | See [`docs/`](./docs) |
| `/agent` front door | Active | See [`site-agent/`](./site-agent) |
| Privacy / zk settlement | Separate repo | Use [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) |

## Product Boundary

Parad0x Labs has two separate lanes:

1. **DNA x402**
   - Fast payment rail for agent commerce
   - Optimized for the hot path: `402 -> pay -> retry -> receipt`
   - No zk-SNARK proving in the live per-request path

2. **Dark Null Protocol**
   - Separate privacy settlement protocol
   - Optimistic-ZK / challenge-window design
   - Different latency and operational profile
   - Optional DNA receipt privacy path for paid unlocks that need hash-only private receipt summaries

This repo is **not** a mixer repo, privacy-pool product page, or zk hot-path payment system.

![DNA x402 Architecture](./docs/assets/dna-architecture.svg)

## What ships in this repo

### Payments and Verification
- x402 HTTP payment flows for APIs and agents
- Solana settlement via netting, SPL transfers, and stream-style access flows
- Signed receipts and anchored receipt commitments
- Optional Dark Null private receipt request path
- Replay protection, wrong-recipient checks, wrong-mint checks, underpay checks

### Intelligence and Routing
- quote comparison and ranking
- reputation scoring and shop badges
- surge pricing and limit orders
- abuse reporting and trust warnings
- heartbeat telemetry and market snapshots

### Developer Tooling
- seller SDK and paywall helpers
- buyer SDK and `fetchWith402`
- x402 Doctor for dialect detection and fix hints
- proof/audit runners, stress tests, and benchmarking scripts

## Public Beta Builder And Agent Launch Pack

DNA x402 now includes a Public Beta builder and agent developer pack for users and teams building paid APIs, agents, data feeds, tools, and vertical apps on the rail.

Start here:

- Public Beta config: [`config/x402.public-beta.example.json`](./config/x402.public-beta.example.json)
- API reference: [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md)
- Builder quickstart: [`docs/BUILDER_QUICKSTART.md`](./docs/BUILDER_QUICKSTART.md)
- Agent quickstart: [`docs/AGENT_QUICKSTART.md`](./docs/AGENT_QUICKSTART.md)
- Degen Mode: [`docs/DNA_X402_DEGEN_MODE.md`](./docs/DNA_X402_DEGEN_MODE.md)
- Seller listing guide: [`docs/SELLER_LISTING_GUIDE.md`](./docs/SELLER_LISTING_GUIDE.md)
- Builder fees: [`docs/BUILDER_FEES.md`](./docs/BUILDER_FEES.md)
- Public Beta acceptance: [`docs/DNA_X402_PUBLIC_BETA_ACCEPTANCE.md`](./docs/DNA_X402_PUBLIC_BETA_ACCEPTANCE.md)

Examples:

- [`examples/buyer-agent-ts`](./examples/buyer-agent-ts)
- [`examples/seller-paid-api-ts`](./examples/seller-paid-api-ts)
- [`examples/builder-monetized-agent-ts`](./examples/builder-monetized-agent-ts)
- [`examples/webhook-receiver-ts`](./examples/webhook-receiver-ts)
- [`examples/receipt-verifier-ts`](./examples/receipt-verifier-ts)

Acceptance:

```bash
npm run acceptance:builder
```

Public Beta scope: users can create paper agents, public profiles, copy settings, and builder/API integrations. Low-risk live payments are open with caps, client-side signing, emergency pause, Telegram monitoring, and visible fee waterfalls. Backend custody, backend signing, hidden fees, auto-sweep, unrestricted autonomous live trading, physical goods, public netting, and high-risk categories are not in beta scope.

### Degen Mode

Connect wallet. Pick agent. Set max pain. Let it cook.

Degen Mode turns Solana trench ideas into safe DNA x402 agent primitives: fresh pair scouts, wallet stalkers, copy-the-chad agents, rug radar, pump radar, paper ape labs, and paid signal rooms. The useful parts are scanner, signal, paper-sim, and trade-intent shapes. The unsafe parts stay out: no pasted private keys, no backend custody, no backend signing, no fake PnL, no guaranteed-profit claims, and no uncapped auto-live execution.

## Degen-Native Use Cases

Launch-facing primitives for Solana-native agents, paid signal rooms, wallet intelligence, private unlocks, and x402-powered monetization loops.

Six frontier-edge primitives built for on-chain degen survival:

| Primitive | What It Does | Daily Win |
|---|---|---|
| `dark-alpha-receipts` | Anti-copytrading receipts - commit hash published, trade hidden until x402 paid reveal | Sell alpha without getting front-run |
| `dark-swarm-capsule` | Proof-carrying service capsule - prove no custody keys, no root keys | Pick the safest relayer without trusting anyone |
| `dark-compressed-leaves` | ZK Compression leaf schema — Light Protocol v2 adapter design (integration planned, not live) | Projected: 10,000 receipts for 0.02 SOL vs 8.9 SOL full accounts |
| `dark-meme-risk` | Hash-only memecoin risk scoring model (live oracle endpoint not deployed) | Score a token before aping - no raw mint in any receipt |
| `dark-fee-optimizer` | P-token (SIMD-0266) + ZK Compression savings model (live routing not wired) | Projected: 50k transfers/day at 98% fewer compute units |
| `ritual-blink-gateway` | **MOONSHOT** — Blinks + x402 + ritual grammar + Token-2022 Hook + HookVerdict capsule, ONE atomic tx | Embed a payment-gated ritual transaction in a tweet link |

Full doc: [`docs/DEGEN_USE_CASES.md`](./docs/DEGEN_USE_CASES.md)
Fee savings: [`docs/FEE_SAVING_SOLANA_PRIMITIVES.md`](./docs/FEE_SAVING_SOLANA_PRIMITIVES.md)
Anti-copytrading spec: [`docs/ANTI_COPYTRADE_ALPHA.md`](./docs/ANTI_COPYTRADE_ALPHA.md)

**807 Rust tests passing. 0 failures. Run:** `cargo test --workspace`

## Start Here

- Package docs: [`x402/README.md`](./x402/README.md)
- Agent integration reference: [`x402/AGENTS.md`](./x402/AGENTS.md)
- Dark Null privacy path: [`docs/DARK_NULL_PRIVACY_PATH.md`](./docs/DARK_NULL_PRIVACY_PATH.md)
- Repository identity: [`docs/REPOSITORY_IDENTITY.md`](./docs/REPOSITORY_IDENTITY.md)
- Proof and rollout docs: [`docs/`](./docs)
- Public site: [`site/`](./site)
- `/agent` UI: [`site-agent/`](./site-agent)

## Quick Start

```bash
git clone https://github.com/Parad0x-Labs/dna-x402
cd dna-x402/x402
npm install
cp .env.example .env
npm run build
npm start
```

For local seller flows and buyer testing, open [`x402/README.md`](./x402/README.md).

## Repo Layout

| Path | Purpose |
|---|---|
| [`x402/`](./x402) | Canonical package, server, SDKs, verifier, diagnostics |
| [`programs/receipt_anchor/`](./programs/receipt_anchor) | Solana program for receipt anchoring |
| [`docs/`](./docs) | Proof, security, deploy, and programmability docs |
| [`site/`](./site) | Public docs/proof front door |
| [`site-agent/`](./site-agent) | `/agent` onboarding and control-room UI |
| [`scripts/`](./scripts) | Deployment and ops helpers |

## Proof and Docs

- [`docs/PROOF.md`](./docs/PROOF.md)
- [`docs/FOOTPRINT.md`](./docs/FOOTPRINT.md)
- [`docs/PROGRAMMABILITY_CONTRACT.md`](./docs/PROGRAMMABILITY_CONTRACT.md)
- [`docs/X402_COMPAT.md`](./docs/X402_COMPAT.md)
- [`docs/DARK_NULL_PRIVACY_PATH.md`](./docs/DARK_NULL_PRIVACY_PATH.md)
- [`x402/test-mainnet/`](./x402/test-mainnet)

## Alien Tek Research

Deep research across five threads: forgotten e-cash (Chaum 1982, GNU Taler deployed in a Swiss bank), cryptographic holy grails (Diamond iO from PSE 2025, witness encryption now practical for algebraic statements), proof aggregation (SnarkPack in Filecoin production — 819 Groth16 proofs → 2KB, no circuit rebuild), MPC primitives (Snowblind threshold blind signatures where even full signer collusion can't link issuance to spending), and UTXO privacy systems (FCMP++ on Monero Q1 2026 — 100M+ anonymity set, the biggest privacy advance in blockchain history that nobody outside Monero knows about).

The single most underappreciated finding: every deployed ZK payment system has an access pattern leak — your Merkle path fetch tells the full node which leaf you're proving. Piano PIR (2024, IEEE S&P) is at 12ms + 220KB per nullifier check. The fix exists. Zero deployments.

[`docs/DARK_NULL_ALIEN_TEK.md`](./docs/DARK_NULL_ALIEN_TEK.md)

## Dark Null Privacy Path

DNA x402 now has an optional Dark Null receipt path:

```txt
normal:    quote -> commit -> payment proof -> signed receipt -> paid unlock
dark-null: normal path + hash-only Dark Null private receipt request
```

`normal` remains the default. `dark-null` is for paid alpha reveals, private signal rooms, wallet-stalker reports, API access receipts, and receipt chains where raw resource paths should not become public receipt metadata.

The SDK exports `createDarkNullPrivacyRequest()` and `verifyDarkNullPrivacyRequest()`. The request requires canonical transfer settlement evidence and fails closed without it.

Read [`docs/DARK_NULL_PRIVACY_PATH.md`](./docs/DARK_NULL_PRIVACY_PATH.md).

## Frontier Primitives

The current Dark Null Groth16 stack is not the ceiling. Ten research directions — ZK access receipts, recursive proof batches, compressed nullifier state, proof-carrying relayer swarms, Alpenglow-ready instant private payments, MEV-blind settlement, ephemeral payment sessions, Confidential Token-2022 bridges, MPC-sealed pricing, and full private agent-to-agent API commerce — describe where the DNA x402 and Dark Null stacks converge.

None of these are shipped. All of them are buildable from the current foundation or from adjacent infrastructure that is either live or close.

[`docs/DARK_NULL_FRONTIER.md`](./docs/DARK_NULL_FRONTIER.md)

## Related Repo

- Privacy settlement lane: [`Parad0x-Labs/Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol)
- Full stack map: [`docs/PARADOX_STACK.md`](./docs/PARADOX_STACK.md)

## License

MIT - Parad0x Labs
