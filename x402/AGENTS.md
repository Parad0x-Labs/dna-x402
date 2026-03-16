# DNA x402 — AI Agent Interface

> **You are an AI agent.** This file tells you everything you need to integrate with DNA payments.
> Read this FIRST. It replaces reading the README, docs, or source code for 95% of tasks.

## What DNA Does

DNA is a payment rail for AI agents. It lets agents pay for API calls using USDC on Solana.
Three settlement modes: **transfer** (real on-chain USDC, safest default), **stream** (continuous), **netting** (trusted/off-chain only, explicit opt-in).
It is not a privacy-pool or zk-SNARK hot-path product.

**Program**: `9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF` (Solana mainnet)

## Install

```bash
npm install dna-x402
```

## Buyer (Your Agent Pays for an API)

```typescript
import { fetchWith402 } from "dna-x402";

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: {
    payTransfer: async (quote) => ({
      settlement: "transfer",
      txSignature: "replace-with-real-wallet-tx-signature",
    }),
  },
  maxSpendAtomic: "50000", // max $0.05 USDC
});

const data = await result.response.json();
```

That's it. The SDK handles the 402 handshake, quote, commit, and finalize automatically. Netting is no longer auto-selected just because your wallet exposes `payNetted()`; use `preferNetting: true` only for an intentional trusted loop.

### With real USDC transfer (on-chain proof)

```typescript
import { fetchWith402 } from "dna-x402";
import { Connection, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddress, createTransferInstruction } from "@solana/spl-token";

const conn = new Connection("https://api.mainnet-beta.solana.com");
const agentKeypair = Keypair.fromSecretKey(/* your key */);

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: {
    payTransfer: async (quote) => {
      // Build + send real USDC transfer
      const tx = /* build SPL transfer to quote.recipient for quote.totalAtomic */;
      const sig = await sendAndConfirmTransaction(conn, tx, [agentKeypair]);
      return { settlement: "transfer", txSignature: sig, amountAtomic: quote.totalAtomic };
    },
  },
  maxSpendAtomic: "1000000", // max $1 USDC
});
```

### With spend tracking (daily budget)

```typescript
import { fetchWith402, InMemorySpendTracker, InMemoryReceiptStore } from "dna-x402";

const tracker = new InMemorySpendTracker();
const receipts = new InMemoryReceiptStore();

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: myWallet,
  maxSpendAtomic: "50000",
  maxSpendPerDayAtomic: "5000000", // $5/day cap
  receiptStore: receipts,
  spendTracker: tracker,
});
```

## Seller (Sell Compute / AI / Data — Anything)

### Fastest way — self-contained (no separate server needed)

```typescript
import express from "express";
import { dnaSeller, dnaPrice } from "dna-x402/seller";

const app = express();
app.use(express.json());

// 1. Enable payments to your wallet
const pay = dnaSeller(app, { recipient: "YOUR_SOLANA_WALLET" });

// 2. Set a price on any endpoint
app.get("/api/inference", dnaPrice("5000", pay), (req, res) => {
  res.json({ result: "your inference output" });
});

// Free endpoints work normally
app.get("/", (req, res) => {
  res.json({ pricing: { "/api/inference": "$0.005" } });
});

app.listen(3000);
```

That's it. `dnaSeller` mounts `/commit`, `/finalize`, `/receipt/:id` and `/health` automatically, verifies `transfer` proofs locally, returns signed receipts for the payment finalize handshake, and on unlocked JSON responses can emit a stronger delivery-bound receipt for the actual protected body. A `5xx` response does not consume the paid unlock; the scaffold restores the commit for retry.
Any x402 agent hits your endpoint → gets 402 → pays → retries → gets the result.

### Multiple prices on different endpoints

```typescript
app.get("/api/inference", dnaPrice("5000", pay), handler);   // $0.005
app.get("/api/embedding", dnaPrice("1000", pay), handler);   // $0.001
app.post("/api/batch",    dnaPrice("50000", pay), handler);  // $0.05
```

### Advanced — paywall middleware

Use `dnaPaywall` when you want route-level payment gating with self-mounted `/commit`, `/finalize`, and `/receipt/:id` routes. For anchoring, marketplace listing, netting flush, and broader policy controls, move up to the full DNA x402 server:

```typescript
import { dnaPaywall } from "dna-x402";

app.use("/api/premium", dnaPaywall({
  priceAtomic: "10000",
  recipient: "YOUR_WALLET",
  settlement: ["transfer"],
  requireApiKey: true,
  apiKeys: new Set(["key-abc123", "key-def456"]),
}));
```

## Marketplace (Discover + Buy Agent Services)

```typescript
import { marketCall } from "dna-x402";

const result = await marketCall({
  wallet: myWallet,
  marketBaseUrl: "https://dna-server.example",
  marketPolicy: {
    capability: "text-generation",
    maxPrice: 10000,       // max $0.01
    maxLatencyMs: 5000,    // max 5s response time
    settlement: { preferStream: false },
    fallback: { routeNext: true },
  },
});

const data = await result.response.json();
console.log("Used provider:", result.provider.shopId);
```

## Webhooks (Async Payment Notifications)

```typescript
import { WebhookService } from "dna-x402";

const webhooks = new WebhookService({ signingSecret: "your-hmac-secret" });

await webhooks.deliver("https://your-agent/webhook", {
  event: "payment.completed",
  receiptId: "abc-123",
  amountAtomic: "5000",
  settlement: "netting",
});
```

## Audit Logging

```typescript
import { AuditLogger } from "dna-x402";

const audit = new AuditLogger({ filePath: "./audit.ndjson" });
audit.record({ kind: "PAYMENT_VERIFIED", amountAtomic: "5000" });

const recent = audit.query({ kind: "PAYMENT_VERIFIED", limit: 100 });
const ndjson = audit.exportNdjson();
```

## DNA Guard

Use this when the user wants risk controls, provider scoring, or receipt/dispute telemetry without changing the on-chain rail.

```typescript
import { AuditLogger, createDnaGuard, dnaPrice, dnaSeller } from "dna-x402";

const pay = dnaSeller(app, { recipient: "YOUR_SOLANA_WALLET" });
const audit = new AuditLogger({ filePath: "./audit-guard.ndjson" });
const guard = createDnaGuard({ auditLog: audit });

app.use("/guard", guard.router());
app.get("/api/inference", dnaPrice("5000", pay), guard.protect({
  providerId: "seller-a",
  endpointId: "inference",
  amountAtomic: "5000",
  spendCeilings: { buyerAtomic: "15000" },
  failMode: "fail-open",
}), handler);
```

Guard routes:
- `GET /guard/summary`
- `GET /guard/leaderboard`
- `GET /guard/reputation/:providerId`
- `GET /guard/compare?providers=a,b`
- `GET/POST /guard/receipt/:receiptId/verify`

Main server flags:

```bash
DNA_GUARD_ENABLED=1
DNA_GUARD_FAIL_MODE=fail-closed
DNA_GUARD_SNAPSHOT_PATH=./state/dna-guard.json
DNA_GUARD_BUYER_CEILING_ATOMIC=500000
```

Test it with:

```bash
npm run test:guard
```

## Liquefy Bridge (Vault Payment Data)

DNA payment audit trails can be exported to Liquefy `.null` vaults for bit-perfect archival.

```bash
# Export from running DNA server to Liquefy-ready directory
curl -s http://localhost:8080/admin/audit/export | \
  npx tsx src/bridge/liquefy/cli.ts --stdin --out ./vault-staging/run-001

# Pack with Liquefy
python tools/tracevault_pack.py ./vault-staging/run-001 --org dna --out ./vault/run-001
```

### Live sidecar (auto-stream to vault)

```typescript
import { LiquefySidecar } from "dna-x402";

const sidecar = new LiquefySidecar({
  outDir: "./vault-live",
  cluster: "mainnet-beta",
});
sidecar.attachAuditLogger(auditLogger);
sidecar.startPeriodicFlush();
```

## Market Intelligence (query before you buy)

```typescript
// What's trending right now?
const trending = await fetch("https://dna-server/market/trending?window=1h");

// Who's selling the most?
const topSelling = await fetch("https://dna-server/market/top-selling?window=24h");

// Who's making the most revenue?
const topRevenue = await fetch("https://dna-server/market/top-revenue?window=24h");

// Any price drops?
const onSale = await fetch("https://dna-server/market/on-sale?window=24h");

// Price history for a specific endpoint
const history = await fetch("https://dna-server/market/price-history?endpointId=shop::inference&window=7d");

// Full market snapshot (demand velocity, median prices, seller density, volatility, recommended providers)
const snapshot = await fetch("https://dna-server/market/snapshot");
```

Use this to shop smart — find the cheapest provider, spot trends, detect deals, compare before buying.

## Reputation & Badges

Every seller gets a reputation score (0–100) based on:
- Fulfillment rate, latency, dispute rate
- Verified payment rate, uptime
- Anchored receipts count

Tiers: **bronze** (< 50), **silver** (50–79), **gold** (80+)

Badges are auto-awarded: `FAST_P95_<800MS`, `FULFILLMENT_99`, `TOP_SELLER_24H`, `PROOF_ANCHORED`, `STREAM_READY`, `LOW_REFUND`

Quotes include reputation and badges — your agent can filter by them.

## Limit Orders (set and forget)

```typescript
// "Buy inference at max $0.003 — execute when available"
const order = await fetch("https://dna-server/market/orders", {
  method: "POST",
  body: JSON.stringify({
    capability: "text-generation",
    maxPriceAtomic: "3000",
    expiresInMs: 3600000,
    callbackUrl: "https://my-agent/order-filled",
  }),
});
```

DNA auto-executes when a quote matches your constraints. No polling needed.

## Surge Pricing

Prices adjust automatically based on seller load:
- Low load → prices drop to 0.8x
- High load → prices rise up to 2.5x
- Based on: queue depth, inflight requests, p95 latency, error rate

Your agent sees the real-time price in every quote. No surprises.

## Bundle Execution (multi-step chains)

```typescript
// Execute a multi-step workflow as one transaction
// e.g., "search → summarize → translate" in a single bundle
const bundle = await fetch("https://dna-server/market/bundles", {
  method: "POST",
  body: JSON.stringify({
    steps: [
      { capability: "web-search", input: { query: "latest AI news" } },
      { capability: "summarize", input: { fromPrevious: true } },
      { capability: "translate", input: { fromPrevious: true, lang: "es" } },
    ],
  }),
});
```

## OpenAPI / MCP Import

Auto-generate shop endpoints from existing specs:

```typescript
// Import from OpenAPI spec
POST /market/import/openapi
{ "specUrl": "https://my-api.com/openapi.json", "wallet": "MY_WALLET" }

// Import from MCP tool definition
POST /market/import/mcp
{ "tool": { "name": "search", "description": "...", "inputSchema": {...} } }
```

Your existing API becomes a DNA shop with zero manual endpoint configuration.

## Abuse Reporting

```typescript
// Report a bad actor
POST /market/report
{
  "shopId": "scam-shop-123",
  "type": "scam",
  "reason": "Never delivers results after payment"
}
```

Types: `scam`, `illegal`, `malware`, `impersonation`, `other`

## Server Endpoints

### Core Payment
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status |
| `/quote` | GET | Get payment quote |
| `/commit` | POST | Lock a quote for payment |
| `/finalize` | POST | Submit payment proof |
| `/receipt/:id` | GET | Fetch signed receipt |
| `/settlements/flush` | POST | Settle netting batch |
| `/anchoring/receipt/:id` | GET | Check on-chain anchor |

### Marketplace
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/market/shops` | GET | List marketplace shops |
| `/market/shops` | POST | Register a shop |
| `/market/quotes` | GET | Get ranked quotes by capability |
| `/market/orders` | POST | Create a limit order |
| `/market/orders` | GET | List your orders |
| `/market/heartbeat` | POST | Report shop load metrics |
| `/market/trending` | GET | Trending services (velocity) |
| `/market/top-selling` | GET | Most sold (by tx count) |
| `/market/top-revenue` | GET | Highest earning shops |
| `/market/on-sale` | GET | Price drops detected |
| `/market/price-history` | GET | Price chart per endpoint |
| `/market/snapshot` | GET | Full market dashboard |
| `/market/report` | POST | Report abuse |
| `/market/import/openapi` | POST | Import from OpenAPI spec |
| `/market/import/mcp` | POST | Import from MCP tool |

### Admin
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/overview` | GET | System dashboard |
| `/admin/audit/export` | GET | NDJSON audit export |
| `/admin/audit/summary` | GET | Audit event summary |
| `/admin/receipts/:id` | GET | Inspect a receipt |
| `/admin/netting/snapshot` | GET | Netting ledger state |
| `/admin/replay-store/stats` | GET | Replay protection stats |
| `/admin/pause/market` | POST | Pause marketplace writes |
| `/admin/pause/orders` | POST | Pause order execution |
| `/admin/pause/finalize` | POST | Pause payment finalization |

## Environment Variables

```env
CLUSTER=mainnet-beta
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
PAYMENT_RECIPIENT=YOUR_WALLET_ADDRESS
RECEIPT_SIGNING_SECRET=YOUR_ED25519_SECRET_BASE58
ANCHORING_ENABLED=1
RECEIPT_ANCHOR_PROGRAM_ID=9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF
FEE_BPS=30
PORT=8080
```

## SDK Exports

```typescript
// Seller (self-contained — start here)
import { dnaSeller, dnaPrice } from "dna-x402/seller";

// Buyer
import { fetchWith402, marketCall } from "dna-x402";

// Seller (advanced — requires full DNA server)
import { dnaPaywall, apiKeyGuard } from "dna-x402";

// Infrastructure
import { WebhookService, AuditLogger } from "dna-x402";

// Spend management
import { InMemoryReceiptStore, InMemorySpendTracker } from "dna-x402";

// Liquefy bridge
import { LiquefyVaultExporter, LiquefySidecar } from "dna-x402";
```
