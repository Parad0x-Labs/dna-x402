# DNA x402 Builder Monetization

Date: 2026-05-15

Status: `PUBLIC_BETA_DIRECT_SPLIT_DNA_FEE_IMPLEMENTED_BUILDER_DISPLAY_AND_ACCRUAL`

Public direct fee collection: `BLOCKED`

## Purpose

DNA x402 supports builder/integrator monetization as visible, receipt-bound fee lines. This lets external builders launch paid APIs, agents, data feeds, tools, or vertical apps on the rail while preserving DNA's own protocol/platform fee.

Builder monetization is not a license to hide fees, custody funds, auto-sweep balances, or replace the DNA platform fee.

## Revenue Layers

Buyer total payment can be represented as:

```txt
Buyer total payment
├─ Provider / seller amount
├─ DNA platform fee
├─ Builder / integrator fee
└─ Optional affiliate / referrer fee
```

## Current Implementation

Implemented:

- `FeeWaterfallV2`
- `FeeLineKind`
- `FeeCollectionMode`
- `FeeCollectionStatus`
- `BuilderProfile`
- `BuilderFeeConfig`
- `FeeAccrualRecord`
- `SplitPaymentProofRequirement`
- `SplitFinalizeRequest`
- deterministic fee priority and stable `feeWaterfallHash`
- builder quote fee visibility
- receipt-bound fee lines and fee collection summary
- non-custodial accrual records
- direct split proof validator architecture
- HTTP direct split finalize for required fee lines
- receipt-bound split payment proof summaries

Allowed for Public Beta:

- DNA platform fee display-only
- DNA platform fee accrual
- DNA platform fee direct split when `X402_ENABLE_DIRECT_SPLIT_FEES=1`, `X402_DIRECT_SPLIT_GATE_REF` is set, Helius RPC is configured, wallets are allowlisted, tiny caps are active, and Telegram alerts are live
- builder fee display-only
- builder fee accrual
- allowlisted builders
- low-risk APIs/data feeds/tools

Blocked:

- public direct builder fee collection
- public 10 bps collection without explicit direct split fee gate approval
- auto-sweep
- backend fee wallet custody
- SOL-equivalent fee thresholds
- hidden fees
- fee replacement attacks

## DNA Fee Protection

DNA platform fee is a first-class fee line. Builder and affiliate fee lines cannot replace it.

The fee engine calculates in deterministic order:

1. Validate gross amount and token.
2. Calculate DNA platform fee.
3. Calculate builder fee.
4. Calculate affiliate fee.
5. Calculate alpha success fee where applicable.
6. Calculate provider amount.
7. Validate caps and non-negative provider amount.
8. Generate `noDoubleChargeKey`.
9. Generate `feeWaterfallHash`.

## Builder Fee Rules

- Builder fee requires a `BuilderProfile`.
- Builder fee requires a recipient wallet.
- Builder fee must be visible to buyer.
- Builder fee cannot exceed the builder max cap.
- Suspended or disabled builders cannot charge fees.
- Builder fee mode defaults to `display_only`.
- `direct_split` for public builder fee collection is disabled until the direct split fee gate passes.

Policy reason codes include:

- `BUILDER_FEE_RECIPIENT_MISSING`
- `BUILDER_FEE_EXCEEDS_CAP`
- `BUILDER_SUSPENDED`
- `BUILDER_DISABLED`
- `BUILDER_FEE_HIDDEN`
- `BUILDER_FEE_DIRECT_SPLIT_GATED`
- `BUILDER_FEE_DNA_OVERRIDE_ATTEMPT`
- `AFFILIATE_FEE_DISABLED`
- `FEE_WATERFALL_TAMPERED`

## Accrual Mode

Accrual records are non-custodial. They do not move funds.

An accrual record is:

- quote-bound
- receipt-bound when finalized
- recipient-bound
- fee-kind-specific
- exportable
- auditable
- durable in Postgres mode through `fee_waterfalls` and `fee_accruals`

Status starts as `ACCRUED_NOT_COLLECTED`.

Manual settlement, waiver, refund, or partial refund must be an audited action before it changes status.

## Direct Split Mode

Direct split finalize is implemented and gated.

Direct split finalization verifies all required proofs:

- seller/provider proof
- DNA treasury proof
- builder treasury proof
- affiliate treasury proof, if any
- alpha seller proof, if any

Finalize succeeds only when every required fee line has a valid proof for exact chain, token, recipient, and amount, with no replay and no quote mismatch.

Current approved Public Beta scope is seller/provider proof plus DNA treasury proof for low-risk API/data-feed/tool listings. Public direct split remains blocked until:

- server-level multi-recipient split-proof tests pass
- counsel review is complete
- public-production backup operators are assigned
- direct split fee gate approval is recorded
- live-gate approval is recorded
- production deployment evidence is filled

Direct split still forbids backend custody, auto-sweep, SOL-equivalent threshold collection, hidden fee collection, and private key handling.

## Live Postgres Refresh Evidence

Refresh date: 2026-05-15

Status: `PASSED_G_LOCAL_POSTGRES_18_DISPLAY_AND_ACCRUAL_ONLY`

Evidence:

- `fee_accruals` table added to the modular repository/migration set.
- `fee_accruals_payload_receipt_idx` and `fee_accruals_payload_recipient_idx` verified by live migration test.
- Builder accrual record survives repository restart in live Postgres mode.
- Native `pg_dump`/`psql` backup/restore drill seeds and verifies a builder accrual record.
- Postgres-mode server mayhem keeps builder fee abuse paths failing safely.

This proves Public Beta display/accrual persistence. DNA 10 bps direct split HTTP finalize is also real-mainnet dust-tested for the approved Public Beta seller/provider plus DNA treasury scope. It does not approve public direct fee collection or public direct builder fee collection.

## Example Quote

```json
{
  "grossAmount": "100000000",
  "token": "USDC",
  "feeWaterfallV2": {
    "providerAmount": "99400000",
    "totalFees": "600000",
    "lines": [
      {
        "kind": "DNA_PLATFORM_FEE",
        "label": "DNA platform fee",
        "amount": "100000",
        "bps": 10,
        "recipientType": "DNA_TREASURY",
        "collectionStatus": "ACCRUED_NOT_COLLECTED"
      },
      {
        "kind": "BUILDER_FEE",
        "label": "Builder fee",
        "amount": "500000",
        "bps": 50,
        "recipientType": "BUILDER_TREASURY",
        "collectionStatus": "ACCRUED_NOT_COLLECTED"
      }
    ]
  }
}
```

Buyer copy:

```txt
Seller receives: 99.40 USDC
DNA fee: 0.10 USDC
Builder fee: 0.50 USDC
Total: 100.00 USDC
```

## Runtime Config

```txt
X402_PLATFORM_FEE_BPS=10
X402_PLATFORM_FEE_MODE=display_only
X402_PLATFORM_FEE_TREASURY=

X402_ENABLE_BUILDER_FEES=true
X402_BUILDER_FEE_DEFAULT_MODE=display_only
X402_BUILDER_FEE_MAX_BPS=500

X402_ENABLE_AFFILIATE_FEES=false
X402_AFFILIATE_FEE_MAX_BPS=200

X402_ENABLE_DIRECT_SPLIT_FEES=false
X402_DIRECT_SPLIT_GATE_REF=
```

Approved Public Beta DNA direct split example:

```txt
X402_PLATFORM_FEE_BPS=10
X402_PLATFORM_FEE_MODE=direct_split
X402_PLATFORM_FEE_TREASURY=<dna-treasury-public-wallet>
X402_ENABLE_DIRECT_SPLIT_FEES=1
X402_DIRECT_SPLIT_GATE_REF=Public Beta-direct-split-YYYY-MM
FEE_BPS=0
BASE_FEE_ATOMIC=0
MIN_FEE_ATOMIC=0
X402_ENABLE_REAL_CHAIN_DRILL=1
X402_REAL_CHAIN_ALLOWED_SIGNERS=<buyer-wallets>
X402_REAL_CHAIN_MAX_TX_ATOMIC=<tiny-cap>
X402_REAL_CHAIN_DAILY_CAP_ATOMIC=<tiny-daily-cap>
X402_ALERT_TELEGRAM_ENABLED=1
```

Forbidden:

```txt
X402_ENABLE_AUTO_SWEEP=true
X402_AUTO_SWEEP_THRESHOLD_SOL=...
```

## Status Wording

DNA x402 supports builder/integrator monetization as visible, receipt-bound fee lines. Builder fees can be represented in display-only and accrual modes without custody. DNA 10 bps direct split collection is implemented and real-mainnet dust-tested for approved Public Beta flows where finalize requires provider and DNA treasury proofs. Public direct collection remains gated until counsel review, backup operators, and explicit direct split fee gate approval are complete. DNA platform fees remain first-class and cannot be overridden by builder fees.
