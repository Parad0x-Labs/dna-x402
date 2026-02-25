# Deploy x402 on Railway

## Why this path

Railway is the fastest managed path for a public API endpoint with low ops overhead.

## Prerequisites

- Railway account/project
- repo connected to Railway
- environment values from `x402/.env.example`

## Build/run settings

- Root directory: `x402`
- Build command: `npm ci && npm run build`
- Start command: `npm run start`

## Required env

Set at minimum:
- `PORT` (Railway injects one; keep app reading env)
- `SOLANA_RPC_URL`
- `USDC_MINT`
- `PAYMENT_RECIPIENT`
- `RECEIPT_SIGNING_SECRET`
- `APP_VERSION`
- optional anchoring vars if enabled

## Validation

After deploy:

```bash
curl https://<your-api>/health
curl https://<your-api>/status
curl -i https://<your-api>/resource
```

Then run programmable audit against public URL:

```bash
cd x402
npm run audit:programmable -- --cluster devnet --base-url https://<your-api>
```
