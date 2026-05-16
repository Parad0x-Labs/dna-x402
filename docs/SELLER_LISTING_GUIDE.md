# Seller Listing Guide

Status: Public Beta.

Sellers publish signed manifests. Builders can optionally attach builder metadata to the manifest.

## Manifest Fields

Required:

- `manifestVersion`
- `shopId`
- `name`
- `ownerPubkey`
- `endpoints[]`

Optional builder metadata:

```json
{
  "builder": {
    "builderId": "builder_weather",
    "feeConfigId": "weather_fee_v1"
  }
}
```

## Publish

```bash
curl -X POST "$X402_STAGING_API_URL/market/shops" \
  -H "content-type: application/json" \
  --data @signed-manifest.json
```

## Seller API Example

```bash
cd examples/seller-paid-api-ts
npm install
npm run dev
npm test
```

## Policy

Listings can be unavailable in beta or routed to review for restricted categories, missing evidence, high risk, or unsafe builder fee settings.
