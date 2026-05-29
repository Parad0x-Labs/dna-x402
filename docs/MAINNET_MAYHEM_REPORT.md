# Mainnet Mayhem Report

_Generated: 2026-05-29T16:46:37.923Z_

Pure in-process adversarial tests — no mainnet transactions.

## Results

| # | Scenario | Status | Detail |
|---|----------|--------|--------|
| 1 | operatorFeeBps-exceeds-2000 | PASS | operatorFeeBps out of range [0, 2000]: 2001 |
| 2 | protocolFeeBps-exceeds-100 | PASS | protocolFeeBps out of range [0, 100]: 101 |
| 3 | program-id-fee-recipient-rejected | PASS | Fee recipient address is a known program ID — use a treasury wallet instead: Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p |
| 4 | empty-address-rejected | PASS | Fee recipient address must be a non-empty string |
| 5 | invalid-base58-rejected | PASS | Fee recipient address contains invalid base58 characters: 00000000000000000000000000000000 |
| 6 | commercial-fees-nonzero | PASS | operator=2500 protocol=250 |
| 7 | oss-fees-zero | PASS | totalFee=0 providerNet=500000 |
| 8 | session-not-present-returns-402 | PASS | status=402 sessionError="session not found or expired" |
| 9 | parseChainDepth-undefined-is-0 | PASS | depth=0 |
| 10 | parseChainDepth-clamped-to-max-plus-1 | PASS | depth=5 (MAX_CHAIN_DEPTH=4) |
| 11 | chain-depth-exceeds-max-rejected-400 | PASS | depth=5 → status=400 |
| 12 | unknown-session-rejected-402 | PASS | status=402 error="session not found or expired" |

**12 / 12 passed**

> All scenarios passed.

## Coverage

- **Fee boundary enforcement**: operatorFeeBps max 2000, protocolFeeBps max 100
- **Fee recipient safety**: program IDs blocked as fee recipients, empty/invalid addresses rejected
- **Fee arithmetic**: commercial non-zero, OSS zero, providerNet correctness
- **Session logic**: missing/unknown session → 402
- **Chain depth parsing**: undefined → 0, overflow → clamped, exceeded → 400
- **No mainnet transactions**: all tests run in-process against SDK logic only
