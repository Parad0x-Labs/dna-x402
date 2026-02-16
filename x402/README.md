# DNP x402 Module

HTTP-native micropayment service + agent SDK for Dark Null Protocol.

## Handover Notes

Important implementation + startup handover:
`../docs/HANDOVER_MARKET_INTELLIGENCE.md`

## Features shipped

- `GET /resource` returns HTTP `402` + payment requirements
- `POST /commit` + `POST /finalize` + `GET /receipt/:id`
- Signed, hash-chained receipts
- Signed competing marketplace quotes with TTL
- Dynamic fee policy (`max(minFee, base + bps)`) with netting accrual threshold
- Netting ledger keyed by `payerCommitment32B + provider`
- Streamflow wrapper (`createStream`, `topupStream`, `getStream`)
- Strict proof verifiers for SPL transfer and Streamflow proofs
- Tool catalog estimator for realistic call-range budgeting
- Manifest validator (`shop.json`) + marketplace APIs (`/shops`, `/search`, `/quotes`, `/orders`)
- Agent helper: `fetchWith402(url, { wallet, maxSpendAtomic, maxPriceAtomic, maxSpendPerDayAtomic, preferStream })`

## Install

```bash
cd x402
npm install
```

## Run server

```bash
npm run dev
```

Server starts at `http://localhost:8080` by default.

## Run marketplace

```bash
npm run dev:marketplace
```

Marketplace starts at `http://localhost:8090` by default (`MARKETPLACE_PORT` override).

## Run integrated market intelligence

```bash
npm run dev:market
```

This runs the main x402 server with integrated `/market/*` routes and dev telemetry ingest enabled (`MARKET_ALLOW_DEV_INGEST=1`).

## Quick manual flow

1) Request protected resource (expect 402):

```bash
curl -i http://localhost:8080/resource
```

2) Use `quoteId` from response, then commit:

```bash
curl -s http://localhost:8080/commit \
  -H 'content-type: application/json' \
  -d '{"quoteId":"<QUOTE_ID>","payerCommitment32B":"0x1111111111111111111111111111111111111111111111111111111111111111"}'
```

3) Finalize with proof (dev example):

```bash
curl -s http://localhost:8080/finalize \
  -H 'content-type: application/json' \
  -d '{"commitId":"<COMMIT_ID>","paymentProof":{"settlement":"transfer","txSignature":"<TX_SIG>"}}'
```

4) Retry protected resource with payment header:

```bash
curl -s http://localhost:8080/resource -H "x-dnp-commit-id: <COMMIT_ID>"
```

## Test

```bash
npm test
```

### Market-focused test suite

```bash
npm run test:market
```

## Typecheck

```bash
npm run typecheck:x402
```

## Seed market demo data

```bash
npm run seed:market
```

This registers sample shops and quote traffic against a running server (`X402_BASE_URL`, default `http://localhost:8080`).

### Try these seeded SKUs (10)

- Research: `web_search_with_citations`, `pdf_fetch_extract`, `summarize_with_quotes`
- Ops: `classify_fast`, `dedupe_normalize`, `entity_extract`
- Actions: `send_email_stub`, `calendar_book_stub`, `form_fill_stub`
- Always-on: `tool_gateway_stream_access`

## WOW Demo (60s)

1. `npm run dev:market`
2. `npm run seed:market`
3. Open wallet (`wallet` package), go to Marketplace, click `Refresh Market`, then `Try It`
4. In wallet, open `Create Shop Wizard`, paste OpenAPI JSON/URL, import endpoints, publish
5. Re-run quote search and use a quote; inspect receipt and spend ledger export

## WOW Test Suite

```bash
npm run test:wow
```

## Devnet Deploy Tooling

From this package:

```bash
npm run deploy:estimate -- --cluster devnet
npm run deploy:ledger -- --cluster devnet --dry-run
npm run deploy:ledger -- --cluster devnet
npm run deploy:buffers:close -- --cluster devnet
```

Deterministic simulation gate:

```bash
npm run sim:1005 -- --runs 1005 --seed 20260216
npm run sim:10agents
```

Full audit runner (deploy cost + buffer reclaim + pause/proof checks + sim):

```bash
npm run audit:full -- --cluster devnet --deployer-keypair <KEYPAIR> --upgrade-authority <AUTHORITY>
```

Full audited runbook:
`../docs/DEVNET_DEPLOY.md`

## Environment

- `PORT` (default `8080`)
- `SOLANA_RPC_URL` (default devnet)
- `USDC_MINT` (default devnet USDC)
- `PAYMENT_RECIPIENT` (provider wallet)
- `DEFAULT_CURRENCY` (default `USDC`)
- `ENABLED_PRICING_MODELS` (default `flat,surge,stream`)
- `MARKETPLACE_SELECTION` (default `cheapest_sla_else_limit_order`)
- `BASE_FEE_ATOMIC` (default `0`)
- `FEE_BPS` (default `30`)
- `MIN_FEE_ATOMIC` (default `0`)
- `ACCRUE_THRESHOLD_ATOMIC` (default `1000`)
- `MIN_SETTLE_ATOMIC` (default `0`)
- `NETTING_THRESHOLD_ATOMIC` (default `1000`)
- `NETTING_INTERVAL_MS` (default `60000`)
- `QUOTE_TTL_SECONDS` (default `180`)
- `RECEIPT_SIGNING_SECRET` (optional base58 64-byte ed25519 secret)
- `MARKET_ALLOW_DEV_INGEST` (`1` enables `/market/dev/events` for local synthetic telemetry)
- `PAUSE_MARKET` (`1` pauses `/market/*` routes and `/bundle/:id/run`)
- `PAUSE_FINALIZE` (`1` pauses `/finalize`)
- `PAUSE_ORDERS` (`1` pauses `/market/orders*`)

## Verification Tiers

- `FAST`: fulfilled request + payment verified + receipt signature valid.
- `VERIFIED`: `FAST` plus explicit anchoring marker (`anchored === true`) for the paired events.
  - If anchoring is not active, VERIFIED leaderboards should stay empty or below FAST.
