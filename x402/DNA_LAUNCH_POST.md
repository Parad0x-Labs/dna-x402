# DNA x402

### The payment rail AI agents actually deserve.

---

## What is DNA?

DNA x402 is not another agent framework. Not another wrapper. Not another "AI toolkit."

DNA x402 is infrastructure: a micropayment protocol built on Solana that lets agents and APIs transact programmatically with signed receipts and optional on-chain anchoring.

This is the fast payment rail. It is not the separate Dark Null privacy protocol, and it does not put zk-SNARK proving in the hot request path.

We built the **x402 protocol** — HTTP 402 (Payment Required) taken seriously for the first time. Your agent calls an API, gets a 402 response with a price quote, pays, gets a signed receipt, keeps working. No wallets to manage. No popups. No humans in the loop.

---

## What we just did

We took DNA x402 from codebase to tracked mainnet test reports and package release artifacts.

Here's what happened in the last 48 hours:

- Deployed `receipt_anchor` — a custom Solana program that anchors payment receipts on-chain with PDA-based storage, overflow protection, and replay guards
- Ran a **52-test integration suite** against live mainnet — **52/52 passed**
- Simulated real multi-agent trades: 3 buyer agents, 1 seller, across 3 different service types
- Fired 5 rapid burst micropayments to stress-test the netting ledger
- Verified on-chain anchoring of every single receipt
- Tested marketplace registration, discovery, admin controls, pause flags, error handling, replay protection, and multi-tier pricing
- Created burner wallets, funded them, ran the full suite, drained them back. Total cost of the entire test run: **0.000040 SOL**

That last number matters. When your test suite costs less than a fraction of a cent to run on mainnet, you know the micropayment design is right.

---

## Why it works

**The problem everyone else ignores:** AI agents need to transact with each other at machine speed, at machine scale, at machine-sized amounts. We're talking thousands of 0.001 USDC payments per minute. No existing payment rail handles that without either falling over or eating the value in fees.

**How DNA solves it:**

**Netting ledger** — Small payments don't hit the chain individually. They're batched, netted, and settled in bulk. Your agent makes 500 calls at $0.001 each? That's one settlement, not 500 transactions.

**x402 protocol** — Standard HTTP flow. `GET /api/summarize` → `402 Payment Required` → agent reads the quote, commits, pays, gets a receipt. Three HTTP calls. Done. Any language, any framework, any agent.

**Receipt anchoring** — Every payment gets a cryptographically signed receipt. Receipts are batched and anchored on Solana via our `receipt_anchor` program. Immutable proof that payment happened. Auditable forever.

**30 bps fees** — 0.3%. On a $0.001 payment, that's $0.000003 in fees. We're not here to take a cut. We're here to be the rail.

**Marketplace built in** — Sellers register shops with signed manifests. Buyers discover services, compare SLAs, check reputation. It's a programmable economy for agents, not a dashboard for humans.

---

## What agents get

```
npm install dna-x402
```

```typescript
import { fetchWith402 } from "dna-x402";

const result = await fetchWith402("https://provider.ai/api/summarize", {
  body: JSON.stringify({ text: longDocument }),
});
// That's it. Payment handled automatically.
```

Three lines. Your agent now pays for services.

On the provider side:

```typescript
import { dnaPaywall } from "dna-x402/paywall";

app.use("/api/summarize", dnaPaywall({ amountAtomic: "2000" }));
// Your endpoint now charges 0.002 USDC per call.
```

Two lines. Your API now earns money.

---

## The numbers from mainnet

| Metric | Value |
|--------|-------|
| Tests passed | 52/52 |
| Payment flows tested | 8 unique trades |
| Resources tested | /resource, /inference, /stream-access |
| Settlement modes | netting (batched) |
| Receipts anchored on-chain | 8/8 |
| Marketplace shops registered | 1 (with signed ed25519 manifest) |
| Netting batches settled | 8 |
| Admin/audit events logged | 56 |
| Total test cost | 0.000040 SOL |
| Cluster | Solana mainnet-beta |
| Program | `9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF` |

---

## What's inside

- **x402 server** — Quote → Commit → Finalize → Receipt pipeline with Zod-validated schemas
- **Receipt anchoring** — Rust Solana program with PDA buckets, rent-exempt accounts, checked arithmetic
- **Netting ledger** — Off-chain batching with configurable flush intervals
- **Marketplace** — Shop registration, discovery, search, SLA tracking, reputation engine
- **SDK** — `fetchWith402`, `marketCall`, `dnaPaywall`, `WebhookService`, `AuditLogger`
- **Admin API** — Full observability: audit logs, receipt inspection, pause controls, NDJSON export
- **Liquefy bridge** — Optional integration for compressed proof archives and compliance vaults
- **Enterprise ready** — HMAC-signed webhooks, structured audit logging, rate limiting, replay protection

---

## Bottom line

DNA x402 is the payment rail product: tested, packaged, and backed by checked-in mainnet report artifacts in this repo.

The payment rail for the agent economy isn't coming — it's here.

**Coming to your local Git store tonight.**

---

`dna-x402` — Pay. Get paid. Keep building.
