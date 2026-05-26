# Fee Saving Solana Primitives

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) Devnet design only. No audit. mainnet_ready = false.

All CU and lamport numbers below are sourced from published documentation. Sources cited at the bottom of this document.

---

## P-Token (SIMD-0266)

### What It Is

P-Token is a transparent account format introduced by SIMD-0266. It is not a new program — it lives at the same address as the regular SPL Token program. Existing token accounts can be migrated to p-token format without changing the program address, meaning no downstream integrations need to update their program IDs to benefit from the CU reduction.

P-token achieves its CU savings by eliminating redundant deserialization overhead in the SPL Token program. The standard SPL Token program deserializes the full account state on every instruction even when only a small subset of fields are accessed. P-token uses a packed account layout that the program can read with minimal overhead.

The format is "transparent" in the sense that the account data is still human-readable by standard RPC methods — it is not encrypted or obfuscated.

### CU Reduction Numbers

Source: [https://www.helius.dev/blog/solana-p-token](https://www.helius.dev/blog/solana-p-token)

| Instruction | Legacy CU | P-Token CU | Reduction |
|-------------|-----------|------------|-----------|
| Transfer | 4,645 | 79 | 98.3% |
| TransferChecked | 6,200 | 111 | 98.2% |
| CloseAccount | 4,240 | 120 | 97.2% |

These numbers represent the compute units consumed by the SPL Token program instructions themselves, not including base transaction overhead.

### How the Dark Null Fee Optimizer Models the P-Token Path

> **Scope:** The `dark-fee-optimizer` crate models expected CU savings using published p-token benchmarks. It does not execute live token transfers or switch a running system to the p-token account format. P-token accounts must be explicitly migrated; the crate computes the projected savings to inform that decision.

Dark Null's Token-2022 transfer hook architecture requires `TransferChecked` (not `Transfer`) — hook invocation only fires on TransferChecked calls. When the system migrates to p-token account format, those TransferChecked calls will consume 111 CU instead of 6,200 CU.

**Modeled daily savings (50,000 transfers/day):**
- Legacy SPL Token: `6,200 CU × 50,000 = 310,000,000 CU/day`
- P-Token (modeled): `111 CU × 50,000 = 5,550,000 CU/day`
- **Projected savings: 304,450,000 CU/day (98.2% reduction)**

This model has compounding effects once the p-token migration runs:
- More operations fit within the same block CU budget
- Lower priority fee requirements for the same confirmation speed
- Higher throughput ceiling for the same SOL fee budget

The `dark-fee-optimizer` crate exposes `p_token_cu_savings_ratio()` and `p_token_fee_profiles()` for computing projected savings before routing or migration decisions. No live p-token path is executed by the crate itself.

---

## ZK Compression (Light Protocol v2)

### What It Is

ZK Compression is live on Solana mainnet as of the Light Protocol v2 deployment. It stores arbitrary state as Merkle tree leaves instead of full on-chain accounts. A Groth16 validity proof accompanies each batch of state transitions, allowing the Solana runtime to verify the state update without storing each leaf as a full account.

The key insight: Solana's rent model charges for account storage proportional to account size. A standard account holding a 32-byte hash costs 890,880 lamports in rent (~0.00089 SOL). A ZK-compressed leaf holding the same 32-byte hash costs approximately 2,000 lamports (~0.000002 SOL). The validity proof is amortized across the entire batch of leaves.

Source: [https://zkcompression.com](https://zkcompression.com)

### Lamport Cost per Leaf

| Storage Method | Cost per Leaf | SOL Equivalent |
|----------------|--------------|----------------|
| Full on-chain account | 890,880 lamports | ~0.00089 SOL |
| ZK compressed leaf | 2,000 lamports | ~0.000002 SOL |
| **Savings** | **888,880 lamports** | **99.8%** |

### Scale Table

Projected cost at different leaf counts:

| Leaf Count | Compressed Cost (SOL) | Full Account Cost (SOL) | Savings (SOL) |
|------------|----------------------|------------------------|---------------|
| 100 | 0.0002 | 0.089 | 0.0888 |
| 1,000 | 0.002 | 0.89 | 0.888 |
| 10,000 | 0.02 | 8.9 | 8.88 |
| 100,000 | 0.2 | 89.0 | 88.8 |

### How Dark Null Models ZK Compression (Planned Integration)

> **Scope:** The `dark-compressed-leaves` crate defines the leaf hash schema aligned with Light Protocol v2's leaf format. It does **not** connect to the Light Protocol SDK, deploy a state tree, or submit leaves on-chain. Actual Light Protocol state tree integration — deploying a compressed tree, submitting leaves via the Light SDK, and verifying inclusion proofs — is a planned next step, not yet implemented. All cost figures below are modeled from published Light Protocol benchmarks.

Dark Null's design plans to store three categories of data as compressed leaves:

1. **Nullifier sets** — each spent nullifier is a 32-byte leaf. A high-volume system can accumulate tens of thousands of nullifiers. At full account cost this becomes prohibitive; at compressed leaf cost (modeled at 2,000 lamports/leaf) it is economically sustainable.

2. **Commitment trees** — each TradeCommitment produces a 32-byte commitment_hash leaf. For active alpha communities with hundreds of daily trades, compressed storage is the only economically viable option at scale.

3. **Receipt DAGs** — ReceiptChain nodes planned as compressed leaves. The append-only chain property is preserved; the Merkle root would be anchored on-chain; individual nodes compressed.

The `dark-compressed-leaves` crate defines the leaf hash schema (domain bytes, epoch/slot fields, Merkle root construction) compatible with Light Protocol v2's expected leaf format. The `dark-fee-optimizer` crate uses `batch_receipt_savings(count)` to project compression savings before deciding on storage strategy. Neither crate calls Light Protocol SDK functions — the Light integration is the next activation step.

---

## Combined Savings Model

> All figures below are **projections** using published benchmark numbers. Neither the p-token path nor the Light Protocol compression path is executed live by these crates. These models inform the migration decision — they are not measurements of a running system.

For a Dark Null deployment at scale: **10,000 receipts/day** and **50,000 token transfers/day** (modeled).

### P-Token CU Savings

```
Legacy TransferChecked: 6,200 CU per operation
P-Token TransferChecked: 111 CU per operation
Savings per operation: 6,089 CU

Daily savings: 6,089 CU × 50,000 transfers = 304,450,000 CU saved per day
```

304,450,000 CU saved per day is equivalent to approximately 304 full-sized transactions worth of compute budget reclaimed daily.

### ZK Compression Rent Savings

```
Full account rent per leaf: 890,880 lamports
Compressed leaf rent: 2,000 lamports
Savings per leaf: 888,880 lamports

Daily savings: 888,880 lamports × 10,000 receipts = 8,888,800,000 lamports/day
             = 8,888,800,000 / 1,000,000,000 SOL
             = ~8.89 SOL saved per day in rent
```

At current SOL prices (reference only — price not guaranteed), 8.89 SOL/day in rent savings represents a significant operational cost reduction for a high-volume receipt system.

### Monthly Projection (Modeled)

| Metric | Without Optimization | With P-Token + ZK Compression (modeled) | Projected Savings |
|--------|---------------------|-------------------------------|---------|
| CU/day (transfers) | 310,000,000 | 5,550,000 | 304,450,000 CU |
| Rent/day (receipts) | 8.9 SOL | 0.02 SOL | 8.88 SOL |
| Rent/month (receipts) | 267 SOL | 0.6 SOL | 266.4 SOL |

These are projections based on published per-operation figures. Actual costs depend on network conditions, batch sizes, and Light Protocol v2 overhead.

---

## Crate

```
crates/dark-fee-optimizer
```

9 tests, all passing.

```sh
cargo test -p dark-fee-optimizer
```

### Key Functions

**`p_token_fee_profiles()`**
Returns a map of instruction type → (legacy_cu, p_token_cu, savings_ratio) for all supported instruction types. Use this to build routing decisions.

**`estimate_deployment_cost(receipts: u64, transfers: u64) -> DeploymentCostEstimate`**
Given a daily receipt count and daily transfer count, returns projected costs under legacy, p-token-only, compression-only, and fully-optimized configurations.

**`batch_receipt_savings(count: u64) -> BatchSavingsReport`**
Projects lamport savings for a given batch of receipts using ZK compression versus full account storage. Returns total_compressed_cost, total_full_cost, and savings_lamports.

**`p_token_cu_savings_ratio() -> f64`**
Returns the current CU savings ratio for TransferChecked operations (p-token vs legacy). Used by the fee router to decide whether to use the p-token path.

---

## Sources

- **P-Token CU numbers:** [https://www.helius.dev/blog/solana-p-token](https://www.helius.dev/blog/solana-p-token)
- **ZK Compression leaf costs:** [https://zkcompression.com](https://zkcompression.com)
- **SIMD-0266 specification:** [https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0266-p-token.md](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0266-p-token.md)
- **Light Protocol v2:** [https://www.lightprotocol.com](https://www.lightprotocol.com)

---

*Fee Saving Solana Primitives — NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false*
