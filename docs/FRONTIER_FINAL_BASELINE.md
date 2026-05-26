# Dark Null — Frontier Final Baseline Freeze

**Created:** 2026-05-26  
**Purpose:** Immutable snapshot before FRONTIER_FINAL_V1 changes land.

---

## Commit & Branch

| Field | Value |
|-------|-------|
| Commit | `66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186` |
| Branch | `codex/mainnet-hardening` |
| Upstream | `origin/main` (branch is ahead; untracked crates/programs not yet committed) |
| `cargo fmt --all -- --check` | **PASS** (0 diffs after auto-format applied) |
| `cargo test --workspace` | **304 passed, 0 failed** |

---

## Deployed Devnet Programs

| Program | Program ID | Deploy Tx |
|---------|-----------|-----------|
| `dark_nullifier_banks` | `7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj` | [Solscan](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |
| `dark_compressed_receipts` | `FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g` | [Solscan](https://solscan.io/tx/4uht4nvFELfXwDpRhSecLKgoStDAW5Vg2c2LYDoJG2RDU9wh4dMRvNhv1dPTG6pZ9znLj1ngdJKZumeEk4qSfTMT?cluster=devnet) |
| `dark_chaff` | `5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk` | [Solscan](https://solscan.io/tx/22Fr5CaCiwqQwSkRf4Vdjtvy4swLGeJ4SsRn8Jbqv8sC9qeeZ9ZJt8DNrpcq2KnXscP3H7bg9qLcDhbDeMJw6ZKt?cluster=devnet) |

---

## DARKNULL Ritual — Live On Devnet

`DARKNULL` encoded by brute-forcing 32-byte nullifiers per character where
`SHA256(nullifier ‖ epoch_le64 ‖ "dark_null_v1")[0] == ASCII(char)`.

| Char | Shard | NullRec PDA (Solscan devnet) |
|------|-------|------------------------------|
| D | 68 | [Solscan](https://solscan.io/account/79MbJEGy6sVnX54KaaL5pXXDAsEBs5ReJWbYMRjUGXba?cluster=devnet) |
| A | 65 | [Solscan](https://solscan.io/account/5JtnqvHwxQvpikA9srV3K5dhU3YCPqwGXiNgUXsrJeVS?cluster=devnet) |
| R | 82 | [Solscan](https://solscan.io/account/3QqmFXU2Xf9JrgcFkU9WJXbWvXqc8vR5NqLCLp9HMHrm?cluster=devnet) |
| K | 75 | [Solscan](https://solscan.io/account/Bvf4kqjNYWHtVL9d5Rc3tKBKEBt2wBBAnZHTzfEb2xnN?cluster=devnet) |
| N | 78 | [Solscan](https://solscan.io/account/4d1NXRq6wPHHGtBVw2NhXHg5Hfp5oNGKpA7v3Kqzk6Nj?cluster=devnet) |
| U | 85 | [Solscan](https://solscan.io/account/FKLqoHW1dqJ2GQQdSXpGWVnf8Uf9K3JKrPVpU5W4XGVS?cluster=devnet) |
| L | 76 | [Solscan](https://solscan.io/account/8JEsBRJdgEt3CPb3KNbMJJiRAeNXhE4QNr2XKyDd2dY8?cluster=devnet) |
| L | 76 | [Solscan](https://solscan.io/account/2tRqxSwBkVf3AhLrXEiVbFhWkKvP6JxdMC3p2Wd37skT?cluster=devnet) |

Evidence doc: [`docs/SHARD_MESSAGE_EVIDENCE.md`](./SHARD_MESSAGE_EVIDENCE.md)

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
> - Mainnet ready
> - Audited by a third party
> - Production ready for real user funds
> - End-to-end private (ZK proof not wired)
> - Using real Poseidon on-chain
> - Bonsol integrated
> - RISC Zero integrated
> - ZK Compression integrated
> - x402 production live
>
> **This codebase IS:**
> - A Solana devnet prototype
> - 304 Rust tests passing
> - 3 programs deployed on devnet
> - DARKNULL ritual executed on devnet
> - A scaffold for frontier-final privacy infrastructure

---

## Reproduction

```bash
git clone <repo>
cd "DNA x402"
cargo build --workspace
cargo test --workspace  # 304 passed, 0 failed (baseline)
```
