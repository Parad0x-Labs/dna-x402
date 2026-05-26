# ZK Compression Adapter

## Local Simulator — NOT Real Compression

`dark-compression-core` implements a local Merkle simulator:
- Inserts leaves into an in-memory tree
- Computes SHA-256 Merkle roots
- Tracks redeemed nullifiers
- Produces `CompressedTreeUpdate` structs

**This is NOT real ZK Compression.** `validity_proof_hash` is always `[0u8;32]` in the simulator. There is no on-chain compressed account. No Light Protocol program is called.

## Light Protocol Adapter — BLOCKED

`LightProtocolAdapter` implements the same `CompressionBackendTrait` but returns `BackendUnavailable` on every call until the SDK is installed.

**Install (when ready):**
```bash
npm install @lightprotocol/stateless.js
# or Rust SDK:
# cargo add light-sdk
```
See: https://www.zkcompression.com/

## Backend Selection

| Backend | Status | Use case |
|---------|--------|----------|
| `LocalMerkleSimulator` | ✅ Working | Tests, devnet experiments |
| `LightProtocolAdapter` | ❌ BLOCKED | Real compressed accounts on-chain |
| `NoopRejectBackend` | ✅ Fail-closed | Default when unconfigured |

## Compression Readiness Check

```bash
node scripts/compression-readiness-check.mjs
```

## Cost Comparison (Simulated)

Per the `CostComparison` struct in `dark-compressed-receipt-ledger`:

| Leaves | Naive PDA cost (lamports) | Compressed cost (lamports) |
|--------|--------------------------|---------------------------|
| 1 | ~2,287,680 | ~234,528 |
| 100 | ~228,768,000 | ~234,528 |
| 1000 | ~2,287,680,000 | ~234,528 |

**Note: Compressed cost is simulated — actual cost requires Light Protocol deployment.**

## Required Evidence Before Claiming ZK Compression

To claim "ZK Compression live":
→ `dist/alien-final/evidence/zk_compression_real.json` must exist with:
  - Light Protocol program ID
  - On-chain compressed tree address
  - Proof of leaf insertion tx sig

**Current wording allowed:**
"Local Merkle simulation tested. Light Protocol adapter is typed and fail-closed. Real ZK Compression requires Light Protocol SDK installation."
