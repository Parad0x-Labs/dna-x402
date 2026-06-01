# DNA x402: Turn Any API Into Agent-Ready Commerce

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Chain: Solana](https://img.shields.io/badge/Chain-Solana-14F195?style=flat-square)
![Protocol: x402](https://img.shields.io/badge/Protocol-x402-black?style=flat-square)
![Receipts: Anchored](https://img.shields.io/badge/Receipts-Anchored-00C2A8?style=flat-square)

<p align="center">
  <img src="./docs/assets/github-header-dna-x402.png" alt="Parad0x Labs" width="100%" />
</p>

**Any API can become a paid endpoint. Any agent can quote, pay, verify, and continue in one machine-readable loop.**

**Quote. Pay. Verify. Receipt. Anchor.**

DNA x402 is Parad0x Labs' payment rail for agent-to-agent and API commerce on Solana. It turns paid endpoints into machine-readable x402 flows with payment verification, signed receipts, optional on-chain anchoring, analytics, and seller tooling.

The active product in this repository is the [`x402/`](./x402) package.

Canonical public repository:

```txt
https://github.com/Parad0x-Labs/dna-x402
```

`Parad0x-Labs/x402-dna` is a legacy mirror. Public links, install instructions, and builder docs should point to `dna-x402`.

## 💸 What you could build with it

You don't need to be a protocol nerd to use this. A few ways people put it to work:

- 🔌 **Got an API?** Add a few lines and charge per call — paid in USDC the second it's used. No Stripe account, no chargebacks, no monthly fee.
- 🤖 **Got a bot or a data feed?** Sell it per hit. The buyer's bot pays yours automatically — machine to machine, no invoices.
- 🧠 **Building an AI agent?** Let it earn its own keep: hold a wallet, charge for its work, settle on-chain.

You keep your keys — the rail just handles the money. *(Not investment advice; what you build and charge is up to you.)*

### How this fits the Parad0x stack

Parad0x Labs builds Web0 on Solana — money and agents that settle themselves. **You are here: 💸 Payments.**

| Layer | Repo | Does |
|---|---|---|
| 💸 Payments | **dna-x402** (this repo) | x402 rail: quote → pay → verify → receipt → anchor |
| 🛠️ Build | [dna-x402-builders](https://github.com/Parad0x-Labs/dna-x402-builders) | Hosted kit: turn any API/bot into a paid agent |
| 🕶️ Privacy | [Dark-Null-Protocol](https://github.com/Parad0x-Labs/Dark-Null-Protocol) | Groth16 privacy settlement, published proofs |
| 🗜️ Data | [liquefy](https://github.com/Parad0x-Labs/liquefy) | Columnar compression that beats Zstd + audit trails |
| 🎬 Media | [nebula-media](https://github.com/Parad0x-Labs/nebula-media) | Perceptual video re-encoding, VMAF quality proofs |
| 🧠 Local AI | [nulla-local](https://github.com/Parad0x-Labs/nulla-local) | Local-first agent runtime — your machine, your memory |

**See it live** (a consumer app running on these rails): **[parad0xlabs.com](https://parad0xlabs.com)**

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
  frontier_research: docs/DARK_NULL_FRONTIER_RESEARCH.md
  solana_frontier_research: docs/SOLANA_FRONTIER_RESEARCH.md
  degen_use_cases: docs/DEGEN_USE_CASES.md
  anti_copytrade_alpha: docs/ANTI_COPYTRADE_ALPHA.md
  fee_saving_primitives: docs/FEE_SAVING_SOLANA_PRIMITIVES.md
  edge_capstone_flow: docs/EDGE_CAPSTONE_FLOW.md
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

## If you already built agent payment infrastructure

Already have a pay-per-request system, an agent billing gateway, or a
GPU/compute marketplace on Solana? You don't need to rebuild anything.

| If your stack has... | What DNA x402 adds |
|---|---|
| Your own 402 payment handler | x402-standard adapter — your agents reach every x402-gated API without code changes |
| Off-chain settlement records | `receipt_anchor` + Liquefy — 83× compressed receipts, permanent Merkle root on Solana, tamper-proof billing history |
| Ed25519 agent keys | Dark Passport — hardware-bind those keys to a Secure Enclave or passkey, on-chain provable identity |
| GPU/compute operators claiming hardware | NullLive — continuous hardware-attested proof heartbeat, verifiable on Solana |
| Per-request USDC settlement | Compressed audit trail — 1M payment receipts → 32 bytes on-chain, $0.001/day |
| Inference market or compute routing layer | x402 + receipt_anchor — agents pay for compute per-call, receipts prove delivery, permanent audit trail. Settlement infrastructure under your market structure |
| Private signal API behind a key or token gate | x402 paywall — replace key management with per-call USDC. Agents pay the signal endpoint directly, no subscriptions, no admin |
| Autonomous trading agents, execution logs off-chain only | `receipt_anchor` — every signal → filter → execution event anchored permanently on Solana. Verifiable strategy history, no centralized log |

These are additive layers. Drop them in alongside what you already ship.

---

## What just shipped (June 2026)

Seven new packages on top of the payment rail:

| Package | What it does |
|---|---|
| [`@parad0x_labs/outcome-receipts`](./packages/outcome-receipts) | Creator-signed outcome attached to delivery receipt. Success fee fires only if outcome is positive. No-fake-PnL enforced on-chain, not by marketing. |
| [`@parad0x_labs/agent-reputation`](./packages/agent-reputation) | Agent proves delivery rate, accuracy, and latency without revealing any buyer. ZK-ready over receipt history. |
| [`@parad0x_labs/receipt-dag`](./packages/receipt-dag) | Append-only proof chain — every action links to the previous one. Anti-equivocation: same sequence nonce from same agent = on-chain proof of cheating. |
| [`@parad0x_labs/zk-access`](./packages/zk-access) | Agents prove "I have tier X with Y calls left" without revealing wallet. Phase 2: Groth16 circuit. |
| [`@parad0x_labs/blind-access`](./packages/blind-access) | Buyer pays once, receives N access tokens. Server cannot link which buyer spent which token. Phase 2: RSA blind signatures. |
| [`@parad0x_labs/session-channels`](./packages/session-channels) | 200 micro-actions in a session → one compressed receipt batch → one Solana anchor. For bots, devices, and agents with high action frequency. |
| [`docs/SNARKPACK_BATCH_SETTLEMENT.md`](./docs/SNARKPACK_BATCH_SETTLEMENT.md) | Spec: batch N Groth16 proofs into one aggregate verification. 100 agent payment proofs in one tx. Requires SIMD-0302 (G2 ops, PR #549 open). |
| [`@parad0x_labs/royalty-waterfalls`](./packages/royalty-waterfalls) | Recursive fee attribution for derivative agents. Agent B uses Agent A's signal — downstream receipt carries sourceReceiptHash + fee split. No custody, receipt-based only. |
| [`@parad0x_labs/pay-to-receive`](./packages/pay-to-receive) | Charge for inbound attention. Sender pays to have their payload received, processed, or acted on. Receipt binds ciphertextHash + delivery proof. Bots, rooms, agents. |
| [`@parad0x_labs/mcp-server`](./packages/mcp-server) | MCP server exposing the full stack to Claude Desktop, Cursor, Windsurf, and any MCP-compatible agent. Tools: x402_get_quote, anchor_receipt, lookup_passport, build_outcome_receipt, compress_receipts, get_stack_status. |

---

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

## NULL Miner - Decentralized Agent Work Network

Built on top of DNA x402, NULL Miner is a Solana agent-work rail for phones,
browsers, and servers: task receipts, passkey-sealed agent keys, x402 payout
paths, NULL emission accounting, and lottery/root primitives.

**First known open-source Solana stack combining x402-style HTTP payments, signed/anchored receipts, optional Dark Null private receipt settlement, and agent identity/work rails in one public developer workspace.**

> Prior art note: x402 is an open standard with multiple Solana implementations (Coinbase, Pay.sh, Solana Foundation).
> Our specific contribution is the integrated four-layer stack — no competing open-source project ships all layers together.

**438 tests green. 6 native Solana programs in the deploy profile.**

### Current public status

| Surface | Status |
|---|---|
| OSS devnet profile | Ready to deploy with zero fees and zero NULL emission |
| Commercial mainnet profile | Ready for mainnet pilot deploy after wallet/RPC/program-id checks; external audit pending |
| Program enforcement flag | Off by default; flips on post-audit with `--features mainnet` rebuild |
| NULL token | Mainnet mint exists: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` |

### Deploy profile programs

| Program | What it does |
|---|---|
| `dark_semaphore` | Nullifier registry for agent work proofs |
| `dark_secp256r1_vault` | P-256/WebAuthn passkey vault record with encrypted key material stored in a PDA |
| `dark_secp256k1_auth` | MetaMask/ETH address to Solana agent binding via secp256k1 precompile flow |
| `null_token_hook` | Token-2022 transfer-hook gate for passport/allowlist policy |
| `null_lottery` | Keccak/SHA-256 commit-reveal lottery/root primitive with fallback-draw path |
| `null_mint_gate` | NULL emission claim ledger with nullifier replay protection |

### Mainnet pilot path

The commercial profile can be deployed to mainnet as a pilot while external
audit is pending. It creates public transaction evidence and supports
audit/grant funding. This status
must stay visible anywhere the pilot is promoted:

- external audit pending
- internal technical review, automated analysis tools, and regression tests completed
- enforcement flag off until post-audit `--features mainnet` rebuild
- pre-audit production: program accounts live, settlement paths off

The pilot may expose mainnet program accounts and public receipts before the
audit is complete. Stronger enforcement paths activate after audit sign-off
via a `--features mainnet` rebuild.

| Feature | Pre-audit pilot | Post-audit activation |
|---|---|---|
| Program accounts on mainnet | Yes, after deploy txs exist | Yes |
| Receipt/nullifier ledgers | Yes | Yes |
| Passkey vault storage | Yes | Yes, with reviewed enforcement path |
| NULL emission accounting | Yes | SPL mint CPI only after audit sign-off |
| Lottery root/draw records | Yes | Token settlement/winner enforcement only after audit sign-off |
| Enforcement flag | `off` | `on` with `--features mainnet` post-audit rebuild |

### Dual-track: OSS + Commercial

| | OSS Devnet | Commercial Mainnet Pilot |
|---|---|---|
| House fees | 0% | 0.5% config |
| NULL emission | Disabled | 5% accounting config |
| Lottery ticket price | Free | 10 NULL config |
| License | MIT | MIT code, Parad0x-operated deployment |
| Audit gate | Off | Off until external audit review and explicit activation |
| Who it serves | Builders, forks, research | Public tx evidence, commercial mainnet pilot with external audit pending |

```bash
# OSS devnet - free, MIT, zero extraction
./scripts/deploy/devnet-oss.sh

# Commercial mainnet pilot - program deployment only, audit gate remains off
./scripts/deploy/mainnet-commercial.sh
```

Full deployment guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md)

---

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

### Public Frontier Workspace

The full agent-commerce workspace is public in this repository, not hidden in a local-only tree. Current `main` carries a 343-member Cargo workspace: 311 crate entries, 10 Solana program entries, the TypeScript x402 package, the public builder site, and the local agent/admin UI.

Start with [`docs/PUBLIC_FRONTIER_WORKSPACE.md`](./docs/PUBLIC_FRONTIER_WORKSPACE.md) for the public inventory, promoted module map, Dark Null integration points, and regression commands.

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

Public Beta scope: users can create paper agents, public profiles, copy settings, and builder/API integrations. Low-risk live payments are open with client-side signing, emergency pause, Telegram monitoring, and visible fee waterfalls. Backend custody, backend signing, hidden fees, auto-sweep, unrestricted autonomous live trading, physical goods, public netting, and high-risk categories are not in beta scope.

### Degen Mode

Connect wallet. Pick agent. Set max pain. Let it cook.

Degen Mode turns Solana trench ideas into safe DNA x402 agent primitives: fresh pair scouts, wallet stalkers, copy-the-chad agents, rug radar, pump radar, paper ape labs, and paid signal rooms. The useful parts are scanner, signal, paper-sim, and trade-intent shapes. The unsafe parts stay out: no pasted private keys, no backend custody, no backend signing, no fake PnL, no guaranteed-profit claims, and no unrestricted autonomous live execution.

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
| `ritual-blink-gateway` | **FRONTIER EDGE** — Blinks + x402 + ritual grammar + Token-2022 Hook + HookVerdict capsule, ONE atomic tx | Embed a payment-gated ritual transaction in a tweet link |

Full doc: [`docs/DEGEN_USE_CASES.md`](./docs/DEGEN_USE_CASES.md)
Fee savings: [`docs/FEE_SAVING_SOLANA_PRIMITIVES.md`](./docs/FEE_SAVING_SOLANA_PRIMITIVES.md)
Anti-copytrading spec: [`docs/ANTI_COPYTRADE_ALPHA.md`](./docs/ANTI_COPYTRADE_ALPHA.md)
Edge capstone flow: [`docs/EDGE_CAPSTONE_FLOW.md`](./docs/EDGE_CAPSTONE_FLOW.md)

Run the Rust regression suite with: `cargo test --workspace`

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
| [`crates/`](./crates) | Rust primitive workspace for agent commerce, route privacy, receipts, fee logic, and Dark Null bridges |
| [`programs/receipt_anchor/`](./programs/receipt_anchor) | Solana program for receipt anchoring |
| [`programs/live_attestation/`](./programs/live_attestation) | **NullLive** — continuous hardware attestation for live streams. Signed frame batches anchored on Solana every 1–5 min. Badge goes dark when heartbeat stops. See [`docs/NULLLIVE_README.md`](./docs/NULLLIVE_README.md) |
| [`packages/nulllive-sdk/`](./packages/nulllive-sdk) | TypeScript SDK for NullLive attestation packets, Merkle batch roots, and Solana instruction builders (`@parad0x_labs/nulllive-sdk`) |
| [`programs/`](./programs) | Solana program workspace including receipt anchoring, proof gates, nullifier records, transfer hooks, and chaff |
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

## Frontier Research

Deep research across five threads: forgotten e-cash (Chaum 1982, GNU Taler deployed in a Swiss bank), cryptographic holy grails (Diamond iO from PSE 2025, witness encryption now practical for algebraic statements), proof aggregation (SnarkPack in Filecoin production — 819 Groth16 proofs → 2KB, no circuit rebuild), MPC primitives (Snowblind threshold blind signatures where even full signer collusion can't link issuance to spending), and UTXO privacy systems (FCMP++ on Monero Q1 2026 — 100M+ anonymity set, the biggest privacy advance in blockchain history that nobody outside Monero knows about).

The single most underappreciated finding: every deployed ZK payment system has an access pattern leak — your Merkle path fetch tells the full node which leaf you're proving. Piano PIR (2024, IEEE S&P) is at 12ms + 220KB per nullifier check. The fix exists. Zero deployments.

[`docs/DARK_NULL_FRONTIER_RESEARCH.md`](./docs/DARK_NULL_FRONTIER_RESEARCH.md)

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

<p align="center">
  <img src="./docs/assets/github-footer-parad0xlabs.png" alt="NULL — Parad0x Labs open source systems" width="100%" />
</p>

## License

MIT - Parad0x Labs
