# ZK Compression V2 Receipt Log Spec

**TDL #15** — Light Protocol ZK Compression (concurrent Merkle trees) for receipt storage.

Status: **SPEC** — implementation in sprint. See also: `ZK_COMPRESSION_ADAPTER.md` (local simulator + blocked Light Protocol adapter already in codebase).

---

## 1. What ZK Compression Provides

ZK Compression is a Solana primitive that compresses on-chain state using concurrent Merkle trees. Key properties:

- **Solana account compression via concurrent Merkle trees.** Multiple writers can append leaves concurrently without conflicting — each valid path is preserved as a changelog entry. Solana's `spl-account-compression` program enforces this on-chain.
- **State stored off-chain, committed on-chain via Merkle root.** Leaf data (receipt fields) lives in the indexer (Light Protocol node or self-hosted). The chain holds only the 32-byte root and a compact changelog. Leaf existence is proven by a Merkle inclusion proof verified against the on-chain root.
- **1 compressed account ≈ 1/1000th the cost of a regular account.** A regular Solana account storing ~100 bytes costs ~0.002 SOL in rent. A compressed leaf costs ~0.000002 SOL amortized — the tree overhead is paid once at creation and amortized across every leaf inserted.
- **Light Protocol provides the indexer and proof generation infrastructure.** Their hosted indexer tracks all leaf insertions, maintains the off-chain state database, and generates Merkle proofs on demand. Self-hosting is possible for privacy-sensitive deployments.
- **npm package:** `@lightprotocol/stateless.js`

Cost summary at scale:

| Receipts | Regular PDAs (SOL) | ZK Compressed (SOL) | Savings |
|----------|-------------------|---------------------|---------|
| 1        | ~0.002            | ~0.000002           | 1000x   |
| 10,000   | ~20               | ~0.02               | 1000x   |
| 1,000,000| ~2,000            | ~2                  | 1000x   |
| 10,000,000| ~20,000          | ~20                 | 1000x   |

At 10M receipts: **~20 SOL compressed vs ~20,000 SOL regular accounts.**

---

## 2. Receipt Log Design

### Leaf Data Schema

Each x402 payment receipt maps to exactly one compressed leaf. The leaf payload is a fixed-size struct:

```
ReceiptLeaf {
  receipt_id:    [u8; 32]   // UUID v4 as bytes, or SHA-256(payer+payee+timestamp)
  payer:         [u8; 32]   // Solana pubkey of payer
  payee:         [u8; 32]   // Solana pubkey of payee (merchant / resource owner)
  amount_atomic: u64        // Amount in smallest token unit (USDC: 6 decimals)
  timestamp:     i64        // Unix timestamp seconds (i64 for year 2038+ safety)
  result_hash:   [u8; 32]   // SHA-256 of the HTTP response body delivered to payer
}
// Total: 32+32+32+8+8+32 = 144 bytes per leaf
```

`result_hash` is the hash of the actual resource (API response, content, data) delivered in exchange for payment. This enables EU AI Act compliance: a Merkle proof demonstrates the receipt existed AND binds it to the specific result delivered.

### Tree Configuration

| Parameter     | Value         | Rationale |
|---------------|---------------|-----------|
| Tree depth    | 26            | 2^26 = 67,108,864 leaves per tree (~67M receipts) |
| Max buffer    | 64            | Concurrent changelog slots — supports burst writes |
| Canopy depth  | 10            | Top 1023 nodes cached on-chain; reduces proof size by ~70% |

- **New tree when current is full.** The `CompressedReceiptLog` tracks the active tree address. When leaf index reaches 2^26 - 1, a new tree is created and subsequent appends target it. Historical trees remain readable; inclusion proofs reference the tree address in addition to the receipt_id.
- **On-chain footprint per tree: 32 bytes (Merkle root) + tree config account.** Tree config is ~96 bytes. The full on-chain cost per tree is ~0.01 SOL (one-time), supporting 67M receipts.

### Indexer Dependency

Off-chain leaf data is served by:
1. **Light Protocol hosted indexer** (mainnet/devnet): `https://zk.lightprotocol.com` — zero-ops, proof generation included.
2. **Self-hosted** (optional, for GDPR/data residency): run `@lightprotocol/node` alongside the x402 server.
3. **Fallback**: the x402 server maintains a local append log (`receipt_log.jsonl`) that can reconstruct proofs if the indexer is unavailable.

---

## 3. Integration with `receipt_anchor`

### Current State

`receipt_anchor` (Anchor program, `programs/receipt-anchor/`) stores one PDA per receipt:
- PDA seed: `[b"receipt", receipt_id]`
- Account data: 34-byte commitment (`[u8; 32]` hash + 2 metadata bytes)
- Cost: ~0.002 SOL per receipt (rent-exempt minimum for a 34-byte account)

### Upgrade Path

**Phase 1 — Parallel run (sprint target):**
- New receipts are ALSO appended to the ZK compressed tree.
- PDA creation continues for receipts above a configurable `RECEIPT_VALUE_THRESHOLD` (e.g., any receipt > 1 USDC keeps a PDA for fast on-chain lookup).
- Low-value receipts (< threshold) go compressed-only.

**Phase 2 — Full migration (post-audit):**
- PDA creation disabled for all new receipts.
- Compressed tree is the sole on-chain record.
- A migration script compresses all existing PDAs into a genesis tree and closes the accounts (reclaiming rent SOL).

### Batching Strategy

Rather than one Solana tx per receipt, receipts are batched:

```
Batch window:  every 30 seconds  OR  every 1000 receipts (whichever comes first)
Tx per batch:  1 Solana transaction (may include up to 1000 leaf insertions via CPI)
Cost per batch: ~0.00025 SOL
Cost per receipt (amortized): ~0.00000025 SOL
```

Comparison:
| Method | Cost per receipt | 1M receipts |
|--------|-----------------|-------------|
| PDA (current) | ~0.002 SOL | ~2000 SOL |
| ZK Compressed (batched 1000) | ~0.00000025 SOL | ~0.25 SOL |
| **Savings** | **~8000x** | **~8000x** |

The 8x figure in the TDL brief uses a conservative unbatched estimate. With 1000-receipt batching the savings are ~8000x at scale.

### EU AI Act Compliance

The compressed log provides an auditable trail:
- **Article 12 (record-keeping)**: Merkle root on-chain = tamper-evident log commitment.
- **Article 13 (transparency)**: `inclusion_proof(receipt_id)` returns a verifiable proof any auditor can check against the public Solana state.
- **Article 11 (technical documentation)**: `result_hash` binds the payment receipt to the exact AI output delivered.

---

## 4. Implementation Path

### Step 1 — Install SDK

```bash
# From x402/ package root:
npm install @lightprotocol/stateless.js

# Rust programs (if adding a compressed receipt CPI in receipt-anchor):
cargo add light-sdk --features anchor
```

### Step 2 — Instantiate RPC Connection

```typescript
import { createRpc } from "@lightprotocol/stateless.js";

const connection = createRpc(
  process.env.SOLANA_RPC_URL!,
  process.env.LIGHT_PROTOCOL_RPC_URL ?? "https://zk.lightprotocol.com"
);
```

Light Protocol's RPC wraps the standard Solana RPC and adds compression-specific endpoints (`getCompressedAccountsByOwner`, `getValidityProof`, etc.).

### Step 3 — Tree Creation (one-time per tree)

```typescript
import { LightSystemProgram, buildTx } from "@lightprotocol/stateless.js";

async function createReceiptTree(payer: Keypair): Promise<PublicKey> {
  const treeKeypair = Keypair.generate();
  const tx = await LightSystemProgram.createStateTree({
    payer: payer.publicKey,
    newStateTree: treeKeypair.publicKey,
    treeDepth: 26,
    maxBufferSize: 64,
    canopyDepth: 10,
  });
  const sig = await connection.sendAndConfirmTransaction(tx, [payer, treeKeypair]);
  return treeKeypair.publicKey;
}
```

### Step 4 — Implement `CompressedReceiptLog`

See interface in Section 5. The class wraps:
- An in-memory pending queue (receipts not yet committed)
- A flush scheduler (30s interval + 1000-receipt threshold)
- A call to `LightSystemProgram.compress` or equivalent batch CPI on flush
- An indexer query on `getInclusionProof`

### Step 5 — Expose `inclusion_proof` Endpoint

Add to `x402/src/routes/receipts.ts`:

```
GET /receipts/:receiptId/proof
Response: {
  receipt_id: string,
  tree: string,         // base58 tree public key
  leaf_index: number,
  root: string,         // current on-chain root
  proof: string[],      // array of 26 base58 hashes (Merkle path)
  timestamp: number
}
```

Verification by auditor:
1. Hash the leaf data using the same `ReceiptLeaf` schema.
2. Walk the Merkle path from leaf to root.
3. Confirm root matches the on-chain state at the given slot.

---

## 5. TypeScript Interface (Stub — Full Impl in Sprint)

```typescript
export interface ReceiptData {
  receiptId: string;          // UUID or hex string
  payer: string;              // base58 Solana pubkey
  payee: string;              // base58 Solana pubkey
  amountAtomic: bigint;       // e.g. 1_000_000n = 1 USDC
  timestamp: number;          // Unix seconds
  resultHash: string;         // hex SHA-256 of delivered resource
}

export interface MerkleProof {
  tree: string;               // base58 tree address
  leafIndex: number;
  root: string;               // hex Merkle root (matches on-chain)
  path: string[];             // hex sibling hashes, length = tree depth
  slot: number;               // Solana slot at which root was valid
}

export interface CompressedReceiptLog {
  /** Enqueue a receipt for the next batch commit. Resolves immediately. */
  append(receipt: ReceiptData): Promise<void>;

  /** Return the current on-chain Merkle root (hex). */
  getRoot(): Promise<string>;

  /**
   * Return a Merkle inclusion proof for the given receipt_id.
   * Queries the Light Protocol indexer.
   * Throws if receipt not yet committed or not found.
   */
  getInclusionProof(receiptId: string): Promise<MerkleProof>;

  /**
   * Flush the pending queue to Solana.
   * Creates one transaction containing all queued leaf insertions.
   * Returns the Solana transaction signature.
   * Called automatically by the batch scheduler; also callable manually.
   */
  batchCommit(): Promise<string>;

  /** Return total committed leaf count across all trees. */
  totalReceipts(): Promise<number>;

  /** Return the active tree public key (base58). */
  activeTree(): Promise<string>;
}
```

---

## 6. Cost Model Reference

At the time of writing (2026), approximate Solana costs:

| Operation | Cost (SOL) |
|-----------|-----------|
| Create compressed tree (depth 26, canopy 10) | ~0.01 |
| Append 1 leaf (unbatched) | ~0.000025 |
| Append 1000 leaves (batched, 1 tx) | ~0.00025 |
| Proof verification (on-chain CPI) | ~0.000005 |
| Regular PDA creation (34 bytes) | ~0.002 |

Tree creation is paid once. 10M receipts across ~150 trees (67M leaves/tree):
- Tree creation: 150 x 0.01 = **1.5 SOL**
- Leaf insertions (batched 1000): 10,000 batches x 0.00025 = **2.5 SOL**
- **Total: ~4 SOL for 10M receipts**

Regular PDAs: 10M x 0.002 = **20,000 SOL**

**Ratio: ~5,000x cheaper at 10M scale.**

---

## 7. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Light Protocol indexer unavailable | Low | Local `receipt_log.jsonl` fallback; self-hosted indexer option |
| Tree fills faster than expected | Low | Auto-rotate to new tree; monitor leaf count metric |
| Concurrent write conflicts | Low | `maxBufferSize: 64` handles burst; queue serializes writes |
| SDK API breaking changes | Medium | Pin `@lightprotocol/stateless.js` version; integration tests |
| Proof generation latency | Low | Indexer caches proofs; `inclusion_proof` endpoint adds ~50ms p99 |

---

## Related Docs

- `ZK_COMPRESSION_ADAPTER.md` — existing local simulator and blocked Light Protocol adapter
- `RECEIPT_VERIFICATION.md` — current receipt_anchor PDA scheme
- `GOBLIN_ENGINEERING_ROADMAP.md` — overall roadmap context (TDL #15 listed)
- `DARK_ZK_PRIMITIVES.md` — ZK primitives used in Dark NULL layer
