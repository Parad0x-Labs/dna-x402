# Night Cook Evidence — Crates, Programs, Tests, Demoability

> Snapshot date: 2026-05-26
> Branch: codex/mainnet-hardening

---

## Crates Added This Session

| Crate | Tests | Status |
|---|---|---|
| `model-output-receipts` | 6 | ✅ local prototype |
| `public-puzzle-generator` | 6 | ✅ local prototype |
| `telegram-command-receipts` | 6 | ✅ local prototype |

---

## All Crates in Workspace (complete list)

| Crate | Tests | Demoable Now |
|---|---|---|
| `dark-module-abi` | 14 | ✅ `cargo test -p dark-module-abi` |
| `dark-capability-registry` | — | ✅ `cargo test -p dark-capability-registry` |
| `caveat-engine` | 11 | ✅ `cargo test -p caveat-engine` |
| `dark-session-netting` | 7 | ✅ `cargo test -p dark-session-netting` |
| `account-fee-heatmap` | 6 | ✅ `cargo test -p account-fee-heatmap` |
| `nullifier-bank-planner` | 6 | ✅ `cargo test -p nullifier-bank-planner` |
| `compute-coupon-market` | 7 | ✅ `cargo test -p compute-coupon-market` |
| `alt-fog-vault` | 6 | ✅ `cargo test -p alt-fog-vault` |
| `dark-blink-intent` | 7 | ✅ `cargo test -p dark-blink-intent` |
| `rent-bounty-hunter` | 6 | ✅ `cargo test -p rent-bounty-hunter` |
| `session-loss-fuse` | 7 | ✅ `cargo test -p session-loss-fuse` |
| `degen-api-meter` | 6 | ✅ `cargo test -p degen-api-meter` |
| `poison-receipts` | 11 | ✅ `cargo test -p poison-receipts` |
| `copy-sniper-sim` | — | ✅ `cargo test -p copy-sniper-sim` |
| `strategy-cloak-delay` | 6 | ✅ `cargo test -p strategy-cloak-delay` |
| `alpha-leak-meter` | 6 | ✅ `cargo test -p alpha-leak-meter` |
| `agent-kill-switch` | 6 | ✅ `cargo test -p agent-kill-switch` |
| `dark-tip-notes` | 6 | ✅ `cargo test -p dark-tip-notes` |
| `pvp-prediction-receipts` | 6 | ✅ `cargo test -p pvp-prediction-receipts` |
| `dark-gift-notes` | 6 | ✅ `cargo test -p dark-gift-notes` |
| `dispute-receipt-oracle` | 6 | ✅ `cargo test -p dispute-receipt-oracle` |
| `feature-commit-reveal` | 6 | ✅ `cargo test -p feature-commit-reveal` |
| `model-output-receipts` | 6 | ✅ `cargo test -p model-output-receipts` |
| `public-puzzle-generator` | 6 | ✅ `cargo test -p public-puzzle-generator` |
| `telegram-command-receipts` | 6 | ✅ `cargo test -p telegram-command-receipts` |
| `dark-macaroons` | — | ✅ `cargo test -p dark-macaroons` |
| `ghost-spl-ledger` | 8 | ✅ `cargo test -p ghost-spl-ledger` |
| `receipt-rollup-lite` | 6 | ✅ `cargo test -p receipt-rollup-lite` |
| `compute-coupon` | — | ✅ `cargo test -p compute-coupon` |
| `intent-capsule` | 7 | ✅ `cargo test -p intent-capsule` |
| `shape-pool` | 7 | ✅ `cargo test -p shape-pool` |
| `useful-chaff-planner` | 6 | ✅ `cargo test -p useful-chaff-planner` |
| `alt-fog-router` | — | ✅ `cargo test -p alt-fog-router` |
| `dark-poseidon-tree` | — | ✅ `cargo test -p dark-poseidon-tree` |

---

## Programs Added

| Program | Status | Demoable |
|---|---|---|
| `programs/dark_nullifier_banks` | ✅ builds | Local test validator only |
| `programs/dark_compressed_receipts` | ✅ builds | Local test validator only |
| `programs/dark_chaff` | ✅ builds | Local test validator only |
| `programs/receipt_anchor` | ✅ builds | Local test validator only |
| `programs/dark_scratch` | ✅ builds | Local test validator only |

---

## What Is Demoable Now (Local / `cargo test`)

- All unit tests across the workspace via `cargo test --workspace`
- Cost constitution check: `node scripts/check-cost-constitution.mjs`
- Rent bounty finder (mock): `node scripts/find-rent-bounties.mjs`
- All 14 Night Cook demo flow steps via `cargo test -p <crate>`

---

## What Is Local-Only (No Network Required)

- All crate unit tests — purely in-memory, no Solana RPC
- Script outputs are mocked — `find-rent-bounties.mjs` uses hardcoded data
- `check-cost-constitution.mjs` scans files locally

---

## What Requires Devnet

- Deploying Solana programs (`solana program deploy`)
- On-chain nullifier bank sharding (real slot numbers)
- Ghost SPL ledger settlement (real token mint)
- Rent bounty hunting (real abandoned accounts)
- ALT creation and reuse (`createAndExtendLookupTable`)

---

## What Requires ZK Compression / Bonsol (Future)

- Compressed receipt rollups using ZK Compression (Light Protocol)
- On-chain verification of Poseidon tree roots
- Shape-k proof generation and verification (Bonsol RISC0 program)
- Proof of No-Custody Capsule (multi-party ZK commitment)
- Model output ZK binding (prove model version without revealing weights)

---

## Test Count Summary

| Source | Test Count |
|---|---|
| model-output-receipts | 6 |
| public-puzzle-generator | 6 |
| telegram-command-receipts | 6 |
| Rest of workspace (estimated) | 150+ |
| **Total** | **168+** |

_Run `cargo test --workspace 2>&1 | grep "test result"` for exact count._

---

## Forbidden Pattern Compliance

Run `node scripts/check-cost-constitution.mjs` to verify:

- No `per-user PDA` patterns in any source file
- No `per-receipt PDA` patterns
- No `per-action PDA` patterns
- No `rent bomb` patterns
- Every `crates/<name>/src/lib.rs` exists

Expected output: `{ "violations": [], "status": "CLEAN" }`
