# Discord Announcement

---

## DNA x402 — Now Open Source on GitHub

> One payment standard. Every AI agent. No more incompatibility.

DNA x402 is the fast payment rail product. It is separate from Parad0x Labs' privacy work and does not use zk-SNARK proving in the live request path.

**The problem:**
AI agents can't pay each other. Every framework has its own auth, its own billing, its own API keys. Agents from different ecosystems can't transact. The result? Fragmentation. Agents that should collaborate — can't.

**The fix:**
DNA x402. A single open-source payment protocol on Solana. Any agent pays any API. Three HTTP calls. Done.

**What's in the repo:**
```
Standalone x402 server         — drop-in payment infrastructure
SDK (dna-x402)                — 3 lines to buy, 3 lines to sell
Netting ledger                 — batches nano payments off-chain
On-chain USDC transfers        — real SPL transfers, verified
Receipt anchoring              — every receipt on Solana, verifiable
Marketplace                    — agents discover + compare providers
Audit logging                  — NDJSON corporate-grade trail
Webhook service                — HMAC-signed async notifications
Liquefy OpenClaw integration   — payment data → verified .null vaults
```

**Tracked mainnet stress report:**
```
Agents:              50 (30 netting + 20 real USDC transfer)
Total trades:        80
Tests passed:        84/84 (100%)
Amount range:        $0.00001 → $2.00
Receipts anchored:   80/80
Settlement modes:    Netting + Transfer
Duration:            165 seconds
```

**For agents that buy:**
```typescript
import { fetchWith402 } from "dna-x402";

const result = await fetchWith402("https://provider.ai/api/inference", {
  wallet: myWallet,
  maxSpendAtomic: "50000",
});
```

**For APIs that sell:**
```typescript
import { dnaPaywall } from "dna-x402";

app.use("/api/inference", dnaPaywall({
  priceAtomic: "5000",
  recipient: "YOUR_WALLET",
}));
```

**GitHub:**
DNA x402 (standalone): https://github.com/Parad0x-Labs/dna-x402
Liquefy + DNA bridge:  https://github.com/Parad0x-Labs/liquefy-openclaw-integration

**Program:** `9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF`

If you're building agents — plug in, test it, break it. Open source. MIT license.
We want every AI agent speaking the same payment language.

---
---
---

# X Post (single post — copy below)

---

DNA x402 is now open source.

One payment standard for all AI agents. No more incompatibility. No more agents that can't talk money to each other.

What it is:
— x402 protocol on Solana. Any agent pays any API. Programmatically.
— Netting for nano payments ($0.00001+), real on-chain USDC for larger amounts
— 3 lines to integrate as buyer. 3 lines as seller.
— Receipts anchored on-chain. Verifiable by anyone.

Tested: 50 agents, 80 trades, 84/84 passed on mainnet. Zero failures.

Standalone or integrated with Liquefy OpenClaw for payment-gated vaults + audit archival.

github.com/Parad0x-Labs/dna-x402
github.com/Parad0x-Labs/liquefy-openclaw-integration

Program: 9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF

Building agents? Plug in, test it, break it. One language for agent payments.

#DNA #DarkNullApex #Solana #AI #x402 #OpenSource
