# DNA x402 — AI Agent Interface

> **You are an AI agent.** This file tells you everything you need to integrate with DNA payments.
> Read this FIRST. It replaces reading the README, docs, or source code for 95% of tasks.

## What DNA Does

DNA is a payment rail for AI agents. It lets agents pay for API calls using USDC on Solana.
Three settlement modes: **netting** (off-chain batched, cheapest), **transfer** (real on-chain USDC), **stream** (continuous).

**Program**: `9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF` (Solana mainnet)

## Install

```bash
npm install @dna/x402
```

## Buyer (Your Agent Pays for an API)

```typescript
import { fetchWith402 } from "@dna/x402";

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: {
    payNetted: async (quote) => ({
      settlement: "netting",
      amountAtomic: quote.totalAtomic,
      note: "my-agent-run-001",
    }),
  },
  maxSpendAtomic: "50000", // max $0.05 USDC
});

const data = await result.response.json();
```

That's it. The SDK handles the 402 handshake, quote, commit, and finalize automatically.

### With real USDC transfer (on-chain proof)

```typescript
import { fetchWith402 } from "@dna/x402";
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
import { fetchWith402, InMemorySpendTracker, InMemoryReceiptStore } from "@dna/x402";

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
import { dnaSeller, dnaPrice } from "@dna/x402/seller";

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

That's it. `dnaSeller` mounts `/commit`, `/finalize`, `/receipt/:id` and `/health` automatically.
Any x402 agent hits your endpoint → gets 402 → pays → retries → gets the result.

### Multiple prices on different endpoints

```typescript
app.get("/api/inference", dnaPrice("5000", pay), handler);   // $0.005
app.get("/api/embedding", dnaPrice("1000", pay), handler);   // $0.001
app.post("/api/batch",    dnaPrice("50000", pay), handler);  // $0.05
```

### Advanced — with the full DNA server (on-chain verification, anchoring, marketplace)

Use `dnaPaywall` if you're running the full DNA x402 server and want features like receipt anchoring, marketplace listing, netting flush, and webhooks:

```typescript
import { dnaPaywall } from "@dna/x402";

app.use("/api/premium", dnaPaywall({
  priceAtomic: "10000",
  recipient: "YOUR_WALLET",
  requireApiKey: true,
  apiKeys: new Set(["key-abc123", "key-def456"]),
}));
```

## Marketplace (Discover + Buy Agent Services)

```typescript
import { marketCall } from "@dna/x402";

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
import { WebhookService } from "@dna/x402";

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
import { AuditLogger } from "@dna/x402";

const audit = new AuditLogger({ logPath: "./audit.ndjson" });
audit.record({ kind: "PAYMENT_VERIFIED", amountAtomic: "5000" });

const recent = audit.query({ kind: "PAYMENT_VERIFIED", limit: 100 });
const ndjson = audit.exportNdjson();
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
import { LiquefySidecar } from "@dna/x402";

const sidecar = new LiquefySidecar({
  outDir: "./vault-live",
  cluster: "mainnet-beta",
});
sidecar.attachAuditLogger(auditLogger);
sidecar.startPeriodicFlush();
```

## Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status |
| `/quote` | GET | Get payment quote |
| `/commit` | POST | Lock a quote for payment |
| `/finalize` | POST | Submit payment proof |
| `/receipt/:id` | GET | Fetch signed receipt |
| `/settlements/flush` | POST | Settle netting batch |
| `/anchoring/receipt/:id` | GET | Check on-chain anchor |
| `/market/shops` | GET | List marketplace shops |
| `/market/shops` | POST | Register a shop |
| `/market/quotes` | GET | Get marketplace quotes |
| `/admin/overview` | GET | System dashboard |
| `/admin/audit/export` | GET | NDJSON audit export |

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
import { dnaSeller, dnaPrice } from "@dna/x402/seller";

// Buyer
import { fetchWith402, marketCall } from "@dna/x402";

// Seller (advanced — requires full DNA server)
import { dnaPaywall, apiKeyGuard } from "@dna/x402";

// Infrastructure
import { WebhookService, AuditLogger } from "@dna/x402";

// Spend management
import { InMemoryReceiptStore, InMemorySpendTracker } from "@dna/x402";

// Liquefy bridge
import { LiquefyVaultExporter, LiquefySidecar } from "@dna/x402";
```
