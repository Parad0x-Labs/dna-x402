# DNA x402 API Reference

Status: Public Beta reference. This is not unlimited permissionless production approval.

Base URL:

```txt
X402_STAGING_API_URL=https://staging.dna-x402.example
```

Use the local server during development:

```txt
X402_STAGING_API_URL=http://127.0.0.1:4021
```

## Safety Rules

- Public Beta is open for agents, builder APIs, paper trading, copy controls, profiles, and low-risk capped live payments.
- Direct split fee collection requires the direct split beta gate.
- Builder fees are allowed in Public Beta as visible display-only or non-custodial accrual lines.
- Backend private keys, backend signing, unattended signing, auto-sweep, and hidden fees are forbidden.
- High-risk/regulated verticals are not in beta scope yet.

## Health

`GET /health`

Returns basic server health.

`GET /health/db`

Returns database health when Postgres repository mode is enabled.

## Listing Search

`GET /market/search?capability=data_feed&maxPriceAtomic=100000`

Returns marketplace listings that match capability, price, latency, and policy filters.
This is the listing search path builders and buyer agents should use during Public Beta discovery.

## Seller Profile Creation

Public Beta seller profiles are created through the seller onboarding/admin path before public listing. The profile must bind:

- seller profile ID
- owner wallet
- linked wallets when present
- verified domain when present
- tax/compliance state when required
- policy strike state

Unreviewed high-risk seller activation is not in beta scope yet.

## Signed Manifest / Listing Creation

`POST /market/shops`

This is the signed manifest creation path for Public Beta listings.

Body:

```json
{
  "manifest": {
    "manifestVersion": "market-v1",
    "shopId": "weather-agent",
    "name": "Weather Agent",
    "category": "data_enrichment",
    "ownerPubkey": "seller-owner-public-key",
    "builder": {
      "builderId": "builder_weather",
      "feeConfigId": "weather_fee_v1"
    },
    "endpoints": [
      {
        "endpointId": "forecast",
        "method": "GET",
        "path": "/forecast",
        "capabilityTags": ["weather", "forecast"],
        "description": "Paid forecast endpoint",
        "pricingModel": { "kind": "flat", "amountAtomic": "100000" },
        "settlementModes": ["transfer"],
        "sla": { "maxLatencyMs": 1000, "availabilityTarget": 0.99 }
      }
    ]
  },
  "manifestHash": "64-char-hex",
  "signature": "seller-signature",
  "publishedAt": "2026-05-15T00:00:00.000Z"
}
```

Policy can reject or route the listing to review.

## Quote Request

`GET /quote?resource=/resource&amountAtomic=100000`

Public Beta builder fee quote:

```txt
GET /quote?resource=/resource&amountAtomic=100000000&builderId=builder_weather&builderFeeBps=50&builderRecipient=builder-treasury
```

Response includes:

- `quoteId`
- `paymentRequirements`
- `feeWaterfallV2`
- `feeWaterfallV2.lines[]`
- `feeWaterfallV2.feeWaterfallHash`

## Commit

`POST /commit`

```json
{
  "quoteId": "quote-id",
  "payerCommitment32B": "32-byte-commitment-hex"
}
```

Returns `commitId`.

## Finalize / Payment Proof Submit

`POST /finalize`

```json
{
  "commitId": "commit-id",
  "paymentProof": {
    "settlement": "transfer",
    "txSignature": "solana-signature"
  }
}
```

Finalize verifies the payment proof, blocks replay, issues a signed receipt, and records fee accruals when applicable.

### Direct Split Finalize

When a quote contains `feeWaterfallV2.lines[].requiredForFinalize=true`, clients must submit `splitPaymentProofs` instead of one aggregate `paymentProof`.

```json
{
  "commitId": "commit-id",
  "splitPaymentProofs": [
    {
      "feeLineId": "provider-fee-line-id",
      "paymentProof": {
        "settlement": "transfer",
        "txSignature": "seller-transfer-signature",
        "amountAtomic": "999000"
      }
    },
    {
      "feeLineId": "dna-platform-fee-line-id",
      "paymentProof": {
        "settlement": "transfer",
        "txSignature": "dna-treasury-transfer-signature",
        "amountAtomic": "1000"
      }
    }
  ]
}
```

Direct split finalize requires every required fee line proof. Missing DNA proof, wrong treasury recipient, underpaid treasury proof, replay, wrong mint, and proof reuse are rejected before receipt issuance. The receipt includes `feeWaterfallHash`, `feeLines`, `feeCollectionSummary`, and `splitPaymentProofs`.

## Paid Retry

Retry the protected endpoint with the receipt header returned by finalize.

Common receipt header:

```txt
X-DNA-Receipt: <encoded-signed-receipt>
```

## Receipt Verify

`GET /receipt/:receiptId`

Returns the signed receipt payload and signature.

Local SDK verification:

```ts
import { verifySignedReceipt } from "dna-x402";

if (!verifySignedReceipt(receipt)) throw new Error("invalid receipt");
```

## Webhooks

Public Beta sandbox webhook receiver test:

`POST /v1/webhooks/receiver-test`

This route is sandbox-only and unavailable in production unless the sandbox/test flags are explicitly enabled and live money movement is disabled.

Webhook headers:

- `x-dna-signature`
- `x-dna-event`
- `x-dna-timestamp`
- `x-dna-idempotency-key`

## Builder Fee Config

Builder fee quote parameters:

- `builderId`
- `builderFeeBps`
- `builderRecipient`
- `builderFeeMode=display_only|builder_accrual`

Public Beta DNA direct split is available only behind `X402_ENABLE_DIRECT_SPLIT_FEES=1` and `X402_DIRECT_SPLIT_GATE_REF` with capped low-risk flows, Helius RPC, Telegram alerts, and client-side signing. Unapproved direct split collection is not in beta scope.

## Policy Errors

Common policy errors:

- `BUILDER_FEE_RECIPIENT_MISSING`
- `BUILDER_FEE_EXCEEDS_CAP`
- `BUILDER_SUSPENDED`
- `BUILDER_DISABLED`
- `BUILDER_FEE_HIDDEN`
- `BUILDER_FEE_DIRECT_SPLIT_GATED`
- `BUILDER_FEE_DNA_OVERRIDE_ATTEMPT`
- `AFFILIATE_FEE_DISABLED`
- `FEE_WATERFALL_TAMPERED`

## Replay Errors

Replay failures are returned when a transfer, stream, webhook, or proof key has already been used.

Common codes:

- `X402_REPLAY_DETECTED`
- `X402_PROOF_FOR_DIFFERENT_QUOTE`
- `X402_COMMIT_REUSED`
- `WEBHOOK_REPLAY_REJECTED`

## Agent Wallets

Public Beta endpoint:

`POST /v1/agents/:agentId/wallets/register`

Registers an agent wallet public key only.

Required body:

```json
{
  "ownerWallet": "mother-wallet-public-key",
  "publicKey": "agent-wallet-public-key",
  "chain": "SOLANA",
  "keyStorage": "LOCAL_ENCRYPTED"
}
```

Forbidden in any request payload:

- `privateKey`
- `secretKey`
- `seedPhrase`
- `mnemonic`
- `walletDump`
- `keypair`

Response includes `backendHasPrivateKey: false`.

List wallets:

`GET /v1/agents/:agentId/wallets`

## Paper Agents

Create paper account:

`POST /v1/agents/:agentId/paper-account`

Default starting balance:

```txt
10,000 paper USDC
```

Record paper trade:

`POST /v1/agents/:agentId/paper-trades`

Paper trades do not create real settlement.

## Agent Profiles

Get profile:

`GET /v1/agents/:agentId/profile`

Patch profile:

`PATCH /v1/agents/:agentId/profile`

Leaderboard:

`GET /v1/leaderboard`

Public stats include PnL, ROI, win rate, average entry price, median entry price, volume, sample size, drawdown, follower copied profit/loss, and badges.

## Alpha Monetization

Configure alpha fee:

`POST /v1/agents/:agentId/monetization`

Allowed `successFeeBps`:

- `50`
- `100`
- `150`
- `200`
- `250`
- `300`

Modes:

- `DISPLAY_ONLY`
- `ACCRUAL`

`DIRECT_SPLIT_GATED` requires explicit gate approval.

Alpha fees apply only to positive finalized copied-lot PnL.

## Copy Settings And Decisions

Create settings:

`POST /v1/copy/settings`

Get settings:

`GET /v1/copy/settings/:copySettingsId`

Patch settings:

`PATCH /v1/copy/settings/:copySettingsId`

Pause settings:

`POST /v1/copy/settings/:copySettingsId/pause`

Evaluate a source action:

`POST /v1/copy/decide`

Decision outputs:

- `COPY`
- `SKIP`
- `REVIEW_REQUIRED`

Reason codes include `ENTRY_PRICE_ABOVE_MAX`, `COPY_SELLS_DISABLED`, `MAX_BET_SIZE_EXCEEDED`, `APPROVAL_REQUIRED`, `EMERGENCY_PAUSED`, and `LIVE_COPY_GATED`.

## Copied Lots

Get copied lot:

`GET /v1/copy/lots/:copiedLotId`

List lots for an agent:

`GET /v1/agents/:agentId/copied-lots`

Finalize copied lot:

`POST /v1/copy/lots/:copiedLotId/finalize`

A copied lot can be finalized once. Positive finalized PnL creates alpha accrual if monetization was active at entry. Losses, break-even, and unrealized PnL create no alpha fee.
