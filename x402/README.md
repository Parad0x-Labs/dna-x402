# DNA x402 — Payment Rail for Agents and APIs

`DNA x402` is Parad0x Labs' x402 payment protocol for Solana. Any API can require payment, and any agent can pay programmatically with quote, proof, receipt, and optional on-chain anchoring.

**Program**: [`9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF`](https://solscan.io/account/9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF)

## Why DNA

AI agents need to pay for things: inference, storage, data, compute. Current options are API keys (no metering), credit cards (no agents), or crypto wallets (too manual). DNA solves this with a single SDK that handles quoting, payment, verification, and receipts — from $0.00001 to $100+ per call.

## What This Package Is Not

- Not a mixer
- Not a privacy pool
- Not a zk-SNARK payment hot path

Privacy-oriented Dark Null work is a separate product line. The live DNA x402 request path is optimized for fast payments and does not require zk proof generation per call.

## Features

### Payments
- **Three settlement modes**: Netting (off-chain batched, cheapest), Transfer (real on-chain USDC), Stream (Streamflow time-locked)
- **x402 HTTP standard**: Any REST API becomes payment-gated with one middleware call
- **Receipt anchoring**: Cryptographic receipts anchored on Solana via `receipt_anchor` program with Merkle-style accumulator hashing
- **Replay protection**: TTL-based replay attack prevention on every payment proof
- **Surge pricing**: Dynamic price multipliers (0.8x–2.5x) based on real-time load (queue depth, inflight, latency, error rate)

### Marketplace
- **Shop discovery**: Agents find providers by capability, price, latency, and reputation
- **Reputation engine**: Scores sellers 0–100 based on fulfillment rate, latency, disputes, uptime, and anchored receipts — bronze/silver/gold tiers
- **Badge system**: Auto-awarded badges — `FAST_P95`, `FULFILLMENT_99`, `TOP_SELLER_24H`, `PROOF_ANCHORED`, `STREAM_READY`
- **Ranking engine**: Weighted scoring (50% price, 30% latency, 20% reputation) for quote comparison
- **Limit orders**: Agents set "buy at max $X" — auto-executes when a quote matches
- **Market analytics**: Trending, top-selling, top-revenue, on-sale detection, price history, demand velocity, volatility scores
- **Bundle system**: Multi-step capability chains with cost breakdowns, margin policies, and execution hashing
- **Abuse reporting**: Scam/malware/impersonation reports against shops
- **OpenAPI/MCP import**: Auto-generate shop endpoints from OpenAPI specs or MCP tool definitions
- **Shop templates**: Pre-built configs for research, ops, action, and always-on agent types

### Developer Tools
- **Seller SDK**: Self-contained `dnaSeller()` scaffold for trusted/demo integrations
- **DNA Guard**: Fail-open/fail-closed middleware for spend ceilings, replay alerts, quality validation, receipt verification logs, and provider scoring
- **x402 Doctor**: Diagnostic tool that detects x402 dialects (Coinbase, Memeputer, generic), identifies missing headers, suggests fixes
- **Tool catalog**: Cost estimation, balance coverage, projected spend based on usage patterns
- **25+ structured error codes**: Every error returns hints, trace IDs, docs URLs, and redacted payloads
- **Trace IDs**: UUID per request via `X-TRACE-ID` header

### Infrastructure
- **Audit logging**: NDJSON corporate-grade audit trail for every payment event
- **Webhooks**: HMAC-signed async payment notifications with retry logic and exponential backoff
- **Cached RPC client**: Solana RPC with TTL cache, circuit breaker, retry logic, and in-flight deduplication
- **Heartbeat system**: Real-time shop load monitoring (queue depth, p95 latency, error rate)
- **Admin API**: Full observability — audit export, receipt inspection, pause controls, replay store stats
- **Liquefy bridge**: Archive payment data into verified `.null` vaults with live sidecar streaming
- **Benchmarking suite**: Compute profiling, transaction size analysis, soak test thresholds

## Install

```bash
npm install dna-x402
```

That's it. One command. Works for buyers (AI agents) and sellers (API providers).

## Quick Start

### For Buyers (AI Agents)

```typescript
import { fetchWith402 } from "dna-x402";

const result = await fetchWith402("https://provider.example/api/inference", {
  wallet: {
    payTransfer: async (quote) => ({
      settlement: "transfer",
      txSignature: "replace-with-real-wallet-tx-signature",
    }),
  },
  maxSpendAtomic: "50000",
});

const data = await result.response.json();
```

### For Sellers (Sell Compute, AI, Data — Anything)

```typescript
import express from "express";
import { dnaSeller, dnaPrice } from "dna-x402/seller";

const app = express();
app.use(express.json());

// 1. One line — enable payments to your wallet
const pay = dnaSeller(app, { recipient: "YOUR_SOLANA_WALLET" });

// 2. Gate any endpoint with a price
app.get("/api/inference", dnaPrice("5000", pay), (req, res) => {
  res.json({ result: "inference output" });
});

app.listen(3000);
```

That is the fastest scaffold, not the strongest control surface. `dnaSeller()` now verifies `transfer` proofs through the local Solana payment verifier, emits real signed receipts for the payment finalize handshake, and for unlocked JSON routes emits a second delivery-bound receipt tied to the actual protected response body. Non-JSON handlers still only have the finalize-handshake receipt. Guard policies, replay controls, market routing, and anchoring still live in the full x402 server path.

Transfer is now the default buyer path. Unsigned netting is disabled by default in the main server, and the buyer SDK no longer auto-picks it just because `payNetted()` exists. If you deliberately run a trusted bilateral off-chain settlement loop, opt in with `UNSAFE_UNVERIFIED_NETTING_ENABLED=1` and pass `preferNetting: true` in the buyer call.

### Add DNA Guard (Spend Caps + Quality + Reputation API)

```typescript
import express from "express";
import { AuditLogger, createDnaGuard, dnaPrice, dnaSeller } from "dna-x402";

const app = express();
app.use(express.json());

const pay = dnaSeller(app, { recipient: "YOUR_SOLANA_WALLET" });
const audit = new AuditLogger({ filePath: "./audit-guard.ndjson" });
const guard = createDnaGuard({ auditLog: audit });

app.use("/guard", guard.router());

app.get("/api/inference", dnaPrice("5000", pay), guard.protect({
  providerId: "gpu-cluster-a",
  endpointId: "inference",
  amountAtomic: "5000",
  spendCeilings: { buyerAtomic: "15000", walletAtomic: "25000" },
  qualityValidator: (body) => ({
    ok: typeof (body as { result?: unknown }).result === "string",
    reason: "missing_result_string",
  }),
  failMode: "fail-open",
}), (_req, res) => {
  res.json({ result: "inference output" });
});
```

That gives you:
- spend ceilings per buyer / wallet / agent / api key
- replay anomaly logging
- quality validation and dispute tagging
- `/guard/leaderboard`, `/guard/reputation/:providerId`, `/guard/compare`, `/guard/quote/best`
- receipt verification endpoints at `/guard/receipt/:receiptId/verify`

Use `examples/dna-guard-seller.ts` for the full runnable example.

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
│   ├── server.ts              # Main x402 payment server
│   ├── client.ts              # Agent SDK (fetchWith402, marketCall)
│   ├── catalog.ts             # Tool catalog — cost estimation + balance coverage
│   ├── streaming.ts           # Streamflow integration for streaming payments
│   ├── sdk/
│   │   ├── seller.ts          # Self-contained seller SDK (start here)
│   │   ├── guard.ts           # DNA Guard middleware + provider reputation API
│   │   ├── paywall.ts         # Express payment middleware
│   │   └── webhook.ts         # HMAC webhook delivery with retries
│   ├── market/
│   │   ├── analytics.ts       # Trending, top-selling, revenue, on-sale, price history
│   │   ├── reputation.ts      # Seller reputation scoring (0-100, bronze/silver/gold)
│   │   ├── badges.ts          # Auto-awarded performance badges
│   │   ├── ranking.ts         # Weighted quote ranking (price/latency/reputation)
│   │   ├── orders.ts          # Limit order book with auto-execution
│   │   ├── bundles.ts         # Multi-step capability chains
│   │   ├── heartbeat.ts       # Real-time shop load monitoring
│   │   ├── policy.ts          # Smart routing with preferences and denylists
│   │   ├── import/            # OpenAPI + MCP auto-importers
│   │   └── templates/         # Pre-built shop configs (research, ops, action)
│   ├── pricing/
│   │   └── surge.ts           # Dynamic surge pricing (0.8x–2.5x)
│   ├── x402/
│   │   ├── doctor.ts          # x402 dialect diagnostics + fix suggestions
│   │   ├── errors.ts          # 25+ structured error codes with hints
│   │   └── compat/            # Multi-dialect parser (Coinbase, Memeputer, etc.)
│   ├── verifier/
│   │   ├── splTransfer.ts     # On-chain USDC transfer verification
│   │   ├── streamflow.ts      # Stream payment verification
│   │   ├── replayStore.ts     # Replay attack prevention
│   │   └── rpcClient.ts       # Cached RPC with circuit breaker
│   ├── packing/
│   │   └── anchorV1.ts        # Binary packing + Merkle accumulator hashing
│   ├── logging/
│   │   └── audit.ts           # NDJSON corporate audit logger
│   ├── bridge/liquefy/        # Vault exporter, sidecar, CLI, adapter
│   ├── admin/                 # Admin API (audit, receipts, pause controls)
│   ├── bench/                 # Compute profiling, tx metrics, thresholds
│   └── middleware/             # HTTPS enforcement, trace ID injection
├── examples/
│   ├── sell-compute.ts        # Sell your compute in 10 lines (start here)
│   ├── dna-guard-seller.ts    # Add spend caps, quality checks, and reputation APIs
│   ├── buyer-agent.ts         # Agent paying for APIs
│   ├── seller-api.ts          # API accepting payments (advanced)
│   └── liquefy-gated-vault.ts # Liquefy + DNA integration
├── test-mainnet/
│   ├── mayhem-50.mjs          # 50-agent stress test
│   └── MAYHEM_50_REPORT.md    # Test results
└── AGENTS.md                  # AI agent quick reference
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

## DNA Guard Commands

```bash
npm run test:guard
npx tsx examples/dna-guard-seller.ts
```

Main x402 server integration is now built in behind config flags. When `DNA_GUARD_ENABLED=1`, `createX402App()` mounts `/guard`, enforces spend ceilings during quote/finalize flows, records receipt verification, and persists ledger state if `DNA_GUARD_SNAPSHOT_PATH` is set.

```bash
DNA_GUARD_ENABLED=1
DNA_GUARD_FAIL_MODE=fail-closed
DNA_GUARD_SNAPSHOT_PATH=./state/dna-guard.json
DNA_GUARD_BUYER_CEILING_ATOMIC=500000
DNA_GUARD_WALLET_CEILING_ATOMIC=1000000
```

For custom servers, you can also use the file-backed ledger helper directly:

```typescript
import { createDnaGuard, createFileBackedDnaGuardLedger } from "dna-x402";

const ledger = createFileBackedDnaGuardLedger({
  snapshotPath: "./state/dna-guard.json",
  windowMs: 86_400_000,
});
const guard = createDnaGuard({ ledger });
```

Key routes after mounting `app.use("/guard", guard.router())`:
- `GET /guard/summary`
- `GET /guard/leaderboard`
- `GET /guard/score/:providerId`
- `GET /guard/reputation/:providerId`
- `GET /guard/compare?providers=provider-a,provider-b`
- `GET /guard/quote/best?providers=provider-a,provider-b`
- `GET /guard/receipt/:receiptId/verify`
- `POST /guard/receipt/:receiptId/verify`

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

DNA Guard audit events archive through the same bridge, including:
- spend blocks
- replay alerts
- validation failures and disputes
- receipt verified / invalid states
- fail-open and runtime-error signals

### Live Sidecar (Auto-Archive)

```typescript
import { LiquefySidecar } from "dna-x402";

const sidecar = new LiquefySidecar({
  outDir: "./vault-live",
  cluster: "mainnet-beta",
});
sidecar.attachAuditLogger(auditLogger);
sidecar.startPeriodicFlush();
```

### Payment-Gated Vault Access

Use DNA to monetize Liquefy vault operations. See `examples/liquefy-gated-vault.ts` for a complete example.

## Market Intelligence API

Real-time analytics on every trade flowing through DNA:

| Endpoint | What It Returns |
|----------|----------------|
| `GET /market/trending?window=1h` | What's hot — demand velocity vs previous period |
| `GET /market/top-selling?window=24h` | Most transactions by shop/endpoint |
| `GET /market/top-revenue?window=24h` | Highest earning shops |
| `GET /market/on-sale?window=24h` | Price drops detected |
| `GET /market/price-history?endpointId=X` | Price chart for any endpoint |
| `GET /market/snapshot` | Full dashboard — demand velocity, median prices, seller density, volatility, recommended providers |

Agents use this to shop smart — compare providers, find deals, track trends, and make data-driven purchasing decisions. All programmatic, no human needed.

## Historical Mainnet Reports

This repo includes checked-in mainnet test artifacts for the receipt-anchor and payment rail flows. Summary from the tracked 50-agent stress report:

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
