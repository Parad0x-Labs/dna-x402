# Builder Quickstart

Status: Public Beta.

Builders can launch paid APIs, agents, tools, or data feeds on DNA x402 and add a visible builder fee without replacing DNA's platform fee.

## 1. Configure Public Beta

Use the Public Beta config template at [`../config/x402.public-beta.example.json`](../config/x402.public-beta.example.json).

```bash
export X402_STAGING_API_URL="http://127.0.0.1:4021"
export BUILDER_ID="builder_weather"
export BUILDER_TREASURY="your-builder-treasury-wallet"
export BUILDER_FEE_BPS="50"
```

## 2. Create A Builder-Monetized Quote

```ts
const url = new URL("/quote", process.env.X402_STAGING_API_URL);
url.searchParams.set("resource", "/resource");
url.searchParams.set("amountAtomic", "100000000");
url.searchParams.set("builderId", process.env.BUILDER_ID!);
url.searchParams.set("builderFeeBps", process.env.BUILDER_FEE_BPS!);
url.searchParams.set("builderRecipient", process.env.BUILDER_TREASURY!);
url.searchParams.set("builderFeeMode", "builder_accrual");

const quote = await fetch(url).then((r) => r.json());
console.log(quote.feeWaterfallV2.lines);
```

## 3. What The Buyer Must See

The quote must show:

- seller/provider amount
- DNA platform fee
- builder fee
- total buyer cost
- token/mint
- recipient
- expiry
- fee collection status

## 4. Safe Public Beta Modes

Allowed:

- `display_only`
- `builder_accrual`

Not in beta scope yet:

- public direct collection
- auto-sweep
- backend custody
- hidden fee collection

## 5. Example

Run:

```bash
cd examples/builder-monetized-agent-ts
npm install
npm run dev
npm test
```

Expected output includes a `BUILDER_FEE` line and a DNA platform fee line.
