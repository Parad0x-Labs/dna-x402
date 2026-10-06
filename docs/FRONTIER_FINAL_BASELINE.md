# Dark Null — Frontier Final Baseline Freeze

**Created:** 2026-05-26  
**Purpose:** Immutable snapshot before FRONTIER_FINAL_V1 changes land.

---

## Commit & Branch

| Field | Value |
|-------|-------|
| Commit | `66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186` |
| Branch | `mainnet-hardening` |
| Upstream | `origin/main` (branch is ahead; untracked crates/programs not yet committed) |
| `cargo fmt --all -- --check` | **PASS** (0 diffs after auto-format applied) |
| `cargo test --workspace` | **304 passed, 0 failed** |

---

## Devnet Programs

The devnet deployments of `dark_nullifier_banks`, `dark_compressed_receipts` and `dark_chaff` recorded at this snapshot are withdrawn; since 2026-10-06 they run on devnet at `499rd2qTLyeq9ei4quSzkmJa9ZXwQRaa837Angskuaue`, `7uELrEpcSkbDgYA3xq623QaQmxUi2BXRHUPsKoDVM1oB` and `4TQ4UrJ5bA6dzNmU5gZ5mTF6SS8crA5ffN7BeMsEUt5B` (banks, compressed receipts and chaff suite 19/19, [evidence](../evidence/devnet-2026-10-06/dna-shard-message-banks-compressed-chaff.json)). Program source: [`programs/dark_nullifier_banks/`](../programs/dark_nullifier_banks/), [`programs/dark_compressed_receipts/`](../programs/dark_compressed_receipts/), [`programs/dark_chaff/`](../programs/dark_chaff/).

---

## Workspace at Baseline

- **47 crates** total (22 original + 25 night cook)
- **304 tests passing, 0 failures**

Crates:
```
account-fee-heatmap, agent-kill-switch, alpha-leak-meter, alt-fog-router,
alt-fog-vault, caveat-engine, compute-coupon, compute-coupon-market,
copy-sniper-sim, dark-blink-intent, dark-bundle-cloak, dark-capability-registry,
dark-chaff, dark-compressed-receipts, dark-gift-notes, dark-macaroons,
dark-module-abi, dark-nullifier-banks, dark-poseidon-tree, dark-relay-router,
dark-scratch, dark-session-netting, dark-tip-notes, degen-api-meter,
dispute-receipt-oracle, feature-commit-reveal, ghost-spl-ledger, intent-capsule,
lock-scheduler, model-output-receipts, nullifier-bank-planner, poison-receipts,
public-puzzle-generator, pvp-prediction-receipts, receipt-anchor, receipt-rollup-lite,
receipt-spend, rent-blast-radius, rent-bounty-hunter, sealed-fee-quotes,
session-loss-fuse, shape-pool, state-tier-router, strategy-cloak-delay,
swarm-capsule, telegram-command-receipts, useful-chaff-planner
```

---

## Known Red Gaps (Pre-FRONTIER_FINAL)

| # | Gap | Current State |
|---|-----|---------------|
| 1 | **ZK proof verification** | No real ZK verifier. PDA uniqueness + nullifier checks only. |
| 2 | **Poseidon syscall** | SHA-256 with domain prefix. Not circuit-compatible Poseidon. |
| 3 | **x402 production/devnet flow** | TypeScript x402 server exists; no Rust Dark Null receipt-integrated flow. |
| 4 | **Bonsol / RISC Zero proof layer** | `zkvm/dark_batch_auditor/` stub only. No real proof generation. |
| 5 | **ZK Compression integration** | No compressed account usage. All state in PDAs. |
| 6 | **Audit sign-off packet** | `docs/AUDIT.md` exists; no formal auditor sign-off. |
| 7 | **Mainnet gate / evidence path** | No mainnet deploy. No mainnet evidence. Not planned without audit. |
| 8 | **HMAC-lite in dark-macaroons** | Uses `SHA256(key ‖ msg)`, not RFC2104 HMAC-SHA256. |

---

## Explicit Non-Claims

> **This codebase is NOT:**
> - Deployed on mainnet
> - Cleared for real user funds
> - Private from payer to payee (ZK proof not wired)
> - Using real Poseidon on-chain
> - Bonsol integrated
> - RISC Zero integrated
> - ZK Compression integrated
> - x402 production live
>
> **This codebase IS:**
> - A Solana devnet prototype
> - 304 Rust tests passing
> - 3 programs implemented (on devnet since 2026-10-06; IDs in `configs/devnet.oss.json`)
> - A scaffold for frontier-final privacy infrastructure

---

## Reproduction

```bash
git clone <repo>
cd "DNA x402"
cargo build --workspace
cargo test --workspace  # 304 passed, 0 failed (baseline)
```
