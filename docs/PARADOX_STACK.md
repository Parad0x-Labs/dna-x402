# Parad0x Labs Product Map

## Stack Overview

| Product | Role | Use it for | Do not confuse it with |
|---|---|---|---|
| [`dna-x402`](https://github.com/Parad0x-Labs/dna-x402) | fast payment rail | x402 payment flows, paid APIs, signed receipts, anchoring | privacy settlement protocol |
| [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) | privacy settlement protocol | optimistic-ZK settlement, challengeable privacy flows | machine-speed x402 hot path |
| [`liquefy-openclaw-integration`](https://github.com/Parad0x-Labs/liquefy-openclaw-integration) | compression + audit layer | trace vaults, verified restore, audit trails, agent data protection | payment rail or settlement protocol |
| **Dark Null Solana Frontier Research** (this repo) | SVM-native privacy primitives | sharded nullifier banks, ALT fog, compressed receipts, receipt-spend notes, Jito bundle cloak, leader-aware routing, ephemeral PDA chaff | full ZK settlement (Dark Null Protocol) |

## Fast Routing Guide

- Choose **dna-x402** for `402 -> pay -> retry -> receipt` commerce flows.
- Choose **Dark Null Protocol** for privacy-sensitive settlement with a different latency profile.
- Choose **Liquefy** for compression, auditability, and verified recovery of AI/agent artifacts.

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
  Dark-Null-Protocol:
    category: privacy settlement
    best_for: optimistic-ZK settlement flows
  liquefy-openclaw-integration:
    category: compression and audit layer
    best_for: traces, vaults, logs, restore
  frontier:
    category: research directions
    best_for: understanding where the stack is going
    doc: docs/DARK_NULL_FRONTIER.md
```
