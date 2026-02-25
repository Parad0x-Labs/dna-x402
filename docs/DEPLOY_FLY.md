# Deploy x402 on Fly.io

## Prerequisites

- Fly account and `flyctl` installed
- app created (`fly launch`)

## Config

`x402/fly.toml` is provided for a single service deployment.

## Deploy

```bash
cd x402
fly launch --copy-config --no-deploy
fly secrets set SOLANA_RPC_URL=... USDC_MINT=... PAYMENT_RECIPIENT=... RECEIPT_SIGNING_SECRET=...
fly secrets set APP_VERSION=0.1.0
fly deploy
```

## Validation

```bash
curl https://<your-app>.fly.dev/health
curl https://<your-app>.fly.dev/status
curl -i https://<your-app>.fly.dev/resource
```

Then run programmable audit against public URL:

```bash
cd x402
npm run audit:programmable -- --cluster devnet --base-url https://<your-app>.fly.dev
```
