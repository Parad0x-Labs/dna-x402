# x402 Fee Model — Mainnet-Beta Evidence

_Generated: 2026-05-29T18:52:17.221Z_

## Overview

DNA x402 implements a two-party fee split on each payment:

| Party | Basis Points | Who Sets It | Default |
|-------|-------------|-------------|---------|
| **Operator fee** | 0–2000 bps (0–20%) | Each endpoint builder sets this freely | 0 (builders decide) |
| **Protocol fee** | 0–100 bps (0–1%) | Parad0x official rail only | 5 bps (0.05%) on commercial; 0 on OSS |

### How fees work

The payer sends the full listed price (`priceAtomic`). Both fees are deducted from it
using integer (BigInt) floor division:

```
totalAtomic   = priceAtomic          (what payer sends — unchanged)
operatorFee   = floor(priceAtomic × operatorFeeBps / 10000)
protocolFee   = floor(priceAtomic × protocolFeeBps / 10000)
providerNet   = priceAtomic − operatorFee − protocolFee
```

Dust amounts (fees round to 0) are handled cleanly: for a 9-atomic payment at 50/5 bps,
both fees floor to 0 and the provider receives the full 9 atomic units.

### Fee enforcement status

Fees are currently enforced at the **SDK/receipt metadata level**. On-chain fee-split
enforcement (requiring the payer transaction to split outputs to fee recipients on-chain)
is Sprint 2 scope. This is clearly disclosed in all grant materials.

## Config Tracks

### Commercial track (`configs/mainnet.commercial.json`)
- `operatorFeeBps: 50` — Parad0x's own default for Parad0x-run endpoints. Third-party
  builders set their own value independently.
- `protocolFeeBps: 5` — 0.05% Parad0x official rail fee.
- `protocolFeeRecipient: F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`

### OSS / grant track (`configs/mainnet.oss.json`)
- `operatorFeeBps: 0` — no fees
- `protocolFeeBps: 0` — no fees
- Fully free, forkable, zero-rent x402 implementation

The OSS config exists to prove the protocol is permissionless and freely usable without
any Parad0x intermediation. Grant reviewers can deploy with this config to verify
zero-fee operation.

## Smoke Test Results (2026-05-29T18:52:17.221Z)

| Scenario | Status | Detail |
|----------|--------|--------|
| commercial-config-fees | PASS | operator=5000 protocol=500 total=5500 net=994500 |
| oss-config-fees | PASS | all fees=0 net=1000000 (full amount to provider) |
| dust-payment-floor-division | PASS | 9 atomic: fees=0 net=9 (BigInt floor division) |
| deploy-wallet-not-program-id | PASS | F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY accepted |
| program-id-rejected | PASS | threw as expected: Fee recipient address is a known program ID — use a treasury wallet instead: Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p |

> **All scenarios passed.**

## No Backend Custody

The DNA x402 SDK never:
- Holds user funds in a backend wallet
- Requires backend signing for payments
- Routes payments through a Parad0x-controlled intermediary

Payments go directly on-chain: payer → recipient. The protocol collects its fee
via SDK metadata that the payer validates before signing.
