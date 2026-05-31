# @dna-x402/liquefy-receipts

Columnar compression + bilateral netting + AES-256-GCM encryption for x402 AI agent payment receipt batches.

**1,000 receipts → 1 on-chain Solana tx. 62× compression. Private amounts.**

Part of the [DNA x402](https://github.com/Parad0x-Labs/dna-x402) stack — the x402 payment rail for AI agents on Solana.

## Install

```bash
npm install @dna-x402/liquefy-receipts
```

## Quick start

```ts
import {
  compressReceipts,
  decompressReceipts,
  netReceipts,
  buildReceiptRoot,
  verifyReceiptInBatch,
  buildAnchorIxData,
  generateKey,
  encryptBlob,
} from "@dna-x402/liquefy-receipts";

// Net bilateral flows (1000 receipts → a handful of settlements)
const nets = netReceipts(receipts);

// Compress 62× (columnar, based on Liquefy Columnar Gun v1)
const compressed = compressReceipts(receipts);

// Encrypt (AES-256-GCM — only parties see amounts)
const key  = await generateKey();
const blob = await encryptBlob(compressed, key);

// Build Merkle root (streaming, O(log N) memory — any batch → 32 bytes)
const root = buildReceiptRoot(receipts);

// Verify any receipt is in the batch
const proof    = new MerkleTree(receipts).proof(42);
const verified = verifyReceiptInBatch(receipts[42], proof);

// Anchor instruction for receipt_anchor program (live on Solana mainnet)
const ixData = buildAnchorIxData({
  batchBytes: compressed,
  receiptCount: receipts.length,
  epochId: Math.floor(Date.now() / 86_400_000),
  encrypted: false,
});
```

## What it does

| Feature | Detail |
|---|---|
| **Columnar compression** | 62× on structured JSON (Liquefy Columnar Gun v1 algorithm) |
| **Bilateral netting** | 1M agent receipts → ~4,950 net settlements before anchor |
| **AES-256-GCM** | Private amounts — only transacting parties see values |
| **Streaming Merkle** | O(log N) memory — 36B receipts → 32 bytes on-chain |
| **Inclusion proofs** | Anyone can verify any receipt is in the batch |
| **Anchor instruction** | Builds instruction for `receipt_anchor` (Solana mainnet `6HSRGivd...`) |

## Compression algorithm

Based on [Liquefy](https://github.com/Parad0x-Labs/liquefy) Columnar Gun v1:
- Transpose array-of-receipts into columns
- Delta encode numerics (amounts, timestamps)
- Dictionary encode low-cardinality strings (receivers, program IDs)
- Deflate each column independently
- Same receiver 1000× → stored once

## On-chain programs (Solana mainnet)

| Program | Address |
|---|---|
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` |

## License

MIT — [Parad0x Labs](https://github.com/Parad0x-Labs)
