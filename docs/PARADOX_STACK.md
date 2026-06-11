# Parad0x Labs Product Map

## The Parad0x stack

Parad0x Labs builds Web0 on Solana — money and agents that settle themselves. This
canonical map is mirrored in every repo's "How this fits the Parad0x stack" box.

| Layer | Repo | Does |
|---|---|---|
| 💸 Payments | [dna-x402](https://github.com/Parad0x-Labs/dna-x402) | x402 rail: quote → pay → verify → receipt → anchor |
| 🛠️ Build | [dna-x402-builders](https://github.com/Parad0x-Labs/dna-x402-builders) | Hosted kit: turn any API/bot into a paid agent |
| 🕶️ Privacy | [Dark-Null-Protocol](https://github.com/Parad0x-Labs/Dark-Null-Protocol) | Groth16 privacy settlement, published proofs |
| 🗜️ Data | [liquefy](https://github.com/Parad0x-Labs/liquefy) | Columnar compression that beats Zstd |
| 🛡️ Audit | [liquefy-openclaw-integration](https://github.com/Parad0x-Labs/liquefy-openclaw-integration) | Flight recorder: 24 engines + Solana-anchored audit trails |
| 🎬 Media | [nebula-media](https://github.com/Parad0x-Labs/nebula-media) | Proof-carrying media compression — scene-aware + on-chain receipts |
| 🧠 Local AI | [nulla-local](https://github.com/Parad0x-Labs/nulla-local) | Local-first agent runtime — your machine, your memory |

Token: **$NULL** `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` · usage fills a community rewards war chest · **see it live:** [parad0xlabs.com](https://parad0xlabs.com)

## Do not confuse these

| Product | Is | Is NOT |
|---|---|---|
| `dna-x402` | fast payment rail (402 → pay → retry → receipt) | a privacy settlement protocol |
| `Dark-Null-Protocol` | optimistic-ZK privacy settlement | the machine-speed x402 hot path |
| `liquefy-openclaw-integration` | compression + audit/forensics layer | a payment rail or settlement protocol |
| Dark Null frontier research (lives in `dna-x402/docs`) | SVM-native privacy primitive research | shipped ZK settlement (that is Dark-Null-Protocol) |

## Fast Routing Guide

- Choose **dna-x402** for `402 -> pay -> retry -> receipt` commerce flows.
- Choose **dna-x402-builders** to wrap an existing API or bot into a paid agent without protocol work.
- Choose **Dark-Null-Protocol** for privacy-sensitive settlement with a different latency profile.
- Choose **liquefy** for compression, auditability, and verified recovery of AI/agent artifacts.
- Choose **liquefy-openclaw-integration** for hash-chained, Solana-anchored agent audit trails.
- Choose **nebula-media** for proof-carrying media (video/audio) compression with quality proofs.
- Choose **nulla-local** for a local-first agent runtime that keeps memory on your own machine.

## Frontier Research

Deep research across forgotten e-cash, cryptographic holy grails, proof aggregation, MPC primitives, and UTXO privacy systems. Key findings:

- **The access pattern leak** — every ZK payment system's dirty secret: the Merkle path fetch tells the full node which leaf you're proving. Piano PIR (2024) fixes this at 12ms + 220KB. Zero deployments.
- **BDHKE blind signatures** — 40-year-old Chaum tech, production in Cashu and in a Swiss bank (GNU Taler v1.0, May 2025). The soundness class of bugs that took down Solana's ZK ElGamal program is structurally absent.
- **SnarkPack** — 819 Groth16 proofs → 2KB aggregate, production in Filecoin, O(log N) on-chain verification, no circuit rebuild required.
- **FCMP++** — Monero activated this Q1 2026: anonymity set went from 16 to 100,000,000+ in one hard fork using Curve Trees + Generalized Bulletproofs. The biggest privacy advance in blockchain history. Basically unknown outside Monero.
- **Snowblind** — CRYPTO 2023, threshold blind signatures in pairing-free groups with statistical blindness even if all signers collude.
- **Penumbra ZSwap** — threshold homomorphic flow encryption for private DEX batch clearing, no individual order ever revealed. Most sophisticated private DEX on any PoS chain.

[`docs/DARK_NULL_FRONTIER_RESEARCH.md`](./docs/DARK_NULL_FRONTIER_RESEARCH.md) — cryptographic primitive citations and precedence order.

[`docs/SOLANA_FRONTIER_RESEARCH.md`](./docs/SOLANA_FRONTIER_RESEARCH.md) — Solana-native implementations: ALT fog, sharded nullifier banks, compressed receipts, receipt-spend notes, relay router, bundle cloak, chaff, swarm capsule, sealed fee quotes.

## Frontier Convergence

Where these lanes meet, the stack produces primitives that do not exist anywhere else on Solana:

- **ZK access receipts** — x402 HTTP payment proved by a Groth16 nullifier; the API learns nothing about the caller
- **Recursive proof batches** — PIE+PIP+PAP epoch aggregation where the anonymity set compounds across all sub-batches
- **Compressed nullifier state** — ZK Compression backend so the anonymity set scales to millions of deposits at minimal on-chain cost
- **Proof-carrying relayer swarm** — relayers prove liveness and configuration with circuits; users select by proof, not trust
- **Private ephemeral sessions** — MagicBlock-style fast sessions with a single Dark Null settlement on close
- **Confidential Token-2022 bridge** — T22 hides amounts, Dark Null hides linkage; combined full privacy
- **MEV-aware private settlement** — Jito bundle submission makes timing attacks provably harder
- **Alpenglow-ready UX** — finality drops to ~150ms; maturity windows shrink; private payments feel instant
- **MPC sealed pricing** — Arcium-style private auctions where bids and floor prices are never revealed
- **Private agent-to-agent API commerce** — the full convergence: anonymous machine payments, recursive settlement, MEV-blind, sub-minute privacy

[`docs/DARK_NULL_FRONTIER.md`](./docs/DARK_NULL_FRONTIER.md) — research directions and precedence order.

## LLM Quick Parse

```yaml
parad0x_stack:
  dna-x402:
    category: payment rail
    best_for: paid API and agent commerce
  dna-x402-builders:
    category: hosted builder kit
    best_for: turning any API or bot into a paid agent
  Dark-Null-Protocol:
    category: privacy settlement
    best_for: optimistic-ZK settlement flows
  liquefy:
    category: columnar compression
    best_for: small searchable receipt batches
  liquefy-openclaw-integration:
    category: compression and audit layer
    best_for: traces, vaults, logs, restore
  nebula-media:
    category: proof-carrying media compression
    best_for: video/audio re-encode with quality proofs
  nulla-local:
    category: local-first agent runtime
    best_for: on-device agents and persistent memory
  frontier:
    category: research directions
    best_for: understanding where the stack is going
    doc: docs/DARK_NULL_FRONTIER.md
```
