# DNA x402 — Payment Rails for AI Agents

**DNA** (Dark Null Apex) is an open-source payment protocol for AI agents on Solana. It implements the x402 HTTP payment standard: any API can require payment, and any AI agent can pay — programmatically, with no human in the loop.

**Program**: [`9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF`](https://solscan.io/account/9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF)

## Why DNA

AI agents need to pay for things: inference, storage, data, compute. Current options are API keys (no metering), credit cards (no agents), or crypto wallets (too manual). DNA solves this with a single SDK that handles quoting, payment, verification, and receipts — from $0.00001 to $100+ per call.

## Features

- **Three settlement modes**: Netting (off-chain batched, cheapest), Transfer (real on-chain USDC), Stream (continuous)
- **x402 HTTP standard**: Any REST API becomes payment-gated with one middleware call
- **Receipt anchoring**: All payments get cryptographic receipts anchored on Solana via `receipt_anchor` program
- **Marketplace**: Agents discover and compare providers by capability, price, and latency
- **Audit logging**: NDJSON corporate-grade audit trail for every payment event
- **Webhooks**: HMAC-signed async payment notifications with retry logic
- **Liquefy bridge**: Archive payment data into verified `.null` vaults

## Quick Start

### For Buyers (AI Agents)

```typescript
import { fetchWith402 } from "@dna/x402";

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: {
    payNetted: async (quote) => ({
      settlement: "netting",
      amountAtomic: quote.totalAtomic,
    }),
  },
  maxSpendAtomic: "50000",
});

const data = await result.response.json();
```

### For Sellers (API Providers)

```typescript
import express from "express";
import { dnaPaywall } from "@dna/x402";

const app = express();

app.use("/api/inference", dnaPaywall({
  priceAtomic: "5000",
  recipient: "YOUR_SOLANA_WALLET",
}));

app.get("/api/inference", (req, res) => {
  res.json({ result: "inference output" });
});
```

## Settlement Modes

| Mode | Per-TX Solana Fee | Best For | How It Works |
|------|-------------------|----------|-------------|
| **Netting** | None | Nano/micro payments | Off-chain ledger, batched settlement |
| **Transfer** | ~$0.0001 | Larger payments | Real on-chain USDC SPL transfer |
| **Stream** | ~$0.0001 | Continuous access | Streamflow time-locked payments |

## Architecture

```
Agent (buyer)                         API Provider (seller)
     |                                      |
     |  1. GET /api/inference               |
     |------------------------------------->|
     |  2. 402 Payment Required             |
     |<-------------------------------------|
     |  3. POST /commit (lock quote)        |
     |------------------------------------->|
     |  4. Pay (netting/transfer/stream)    |
     |------------------------------------->|
     |  5. POST /finalize (submit proof)    |
     |------------------------------------->|
     |  6. Receipt + access                 |
     |<-------------------------------------|
     |                                      |
     |  All receipts anchored on Solana     |
     |  via receipt_anchor program          |
```

## Project Structure

```
x402/
├── src/
│   ├── server.ts           # Main x402 payment server
│   ├── client.ts           # Agent SDK (fetchWith402, marketCall)
│   ├── sdk/
│   │   ├── index.ts        # SDK entry point
│   │   ├── paywall.ts      # Express payment middleware
│   │   └── webhook.ts      # HMAC webhook service
│   ├── logging/
│   │   └── audit.ts        # Corporate audit logger
│   ├── market/             # Agent marketplace
│   ├── bridge/
│   │   └── liquefy/        # Liquefy vault bridge
│   └── verifier/           # On-chain payment verification
├── examples/
│   ├── buyer-agent.ts      # Agent paying for APIs
│   ├── seller-api.ts       # API accepting payments
│   └── liquefy-gated-vault.ts  # Liquefy + DNA integration
├── test-mainnet/
│   ├── mayhem-50.mjs       # 50-agent stress test
│   └── MAYHEM_50_REPORT.md # Test results
└── AGENTS.md               # AI agent quick reference
```

## Running the Server

```bash
git clone https://github.com/Parad0x-Labs/dna-x402
cd dna-x402
npm install
cp .env.example .env       # Configure your wallet + RPC
npm run build
npm start
```

## Liquefy Integration

DNA integrates with [Liquefy](https://github.com/Parad0x-Labs/liquefy-openclaw-integration) for archiving payment data into verified `.null` vaults.

### Export Payment Data to Liquefy Vault

```bash
# One-shot export
curl -s http://localhost:8080/admin/audit/export | \
  npx tsx src/bridge/liquefy/cli.ts --stdin --out ./vault-staging/run-001

# Pack with Liquefy
python tools/tracevault_pack.py ./vault-staging/run-001 --org dna --out ./vault/run-001
```

### Live Sidecar (Auto-Archive)

```typescript
import { LiquefySidecar } from "@dna/x402";

const sidecar = new LiquefySidecar({
  outDir: "./vault-live",
  cluster: "mainnet-beta",
});
sidecar.attachAuditLogger(auditLogger);
sidecar.startPeriodicFlush();
```

### Payment-Gated Vault Access

Use DNA to monetize Liquefy vault operations. See `examples/liquefy-gated-vault.ts` for a complete example.

## Mainnet Test Results

50-agent stress test on Solana mainnet:

| Metric | Result |
|--------|--------|
| Agents | 50 (30 netting + 20 transfer) |
| Total Trades | 80 |
| Tests Passed | 84/84 (100%) |
| On-Chain USDC Transfers | 20 |
| Receipts Anchored | 80/80 |
| Amount Range | $0.00001 — $2.00 |

Full report: [`test-mainnet/MAYHEM_50_REPORT.md`](./test-mainnet/MAYHEM_50_REPORT.md)

## API Reference

See [`AGENTS.md`](./AGENTS.md) for the complete API reference and copy-paste integration guide.

## License

MIT — Parad0x Labs
