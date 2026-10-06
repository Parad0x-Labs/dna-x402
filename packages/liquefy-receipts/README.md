# @parad0x_labs/liquefy-receipts

Columnar compression, bilateral netting, AES-256-GCM encryption and a Merkle commitment for batches of
x402 AI agent payment receipts.

**A batch of receipts reduces to one 32-byte Merkle root, which fits in a single 34-byte anchor
instruction. The receipts themselves stay off-chain with you.**

Part of the [DNA x402](https://github.com/Parad0x-Labs/dna-x402) stack, the x402 payment rail for AI agents on Solana.

## Install

```bash
npm install @parad0x_labs/liquefy-receipts
```

The package ships TypeScript source (`src/*.ts`) and no compiled JavaScript. Import it from a
TypeScript-aware runtime or bundler such as tsx, Bun, Vite or esbuild. Plain `node` refuses to
strip types from files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

## Quick start

```ts
import { randomBytes } from "node:crypto";
import {
  compressReceipts,
  decompressReceipts,
  netReceipts,
  buildReceiptRoot,
  MerkleTree,
  verifyReceiptInBatch,
  buildAnchorIxData,
  resolveReceiptAnchorProgramId,
  generateKey,
  importKey,
  encryptBlob,
} from "@parad0x_labs/liquefy-receipts";

// Net bilateral flows: one entry per counterparty pair with a positive balance
const nets = netReceipts(receipts);

// Compress (columnar transform + DEFLATE per column, based on Liquefy Columnar Gun v1)
const compressed = compressReceipts(receipts);

// Encrypt with AES-256-GCM. generateKey() returns raw key bytes; encryptBlob needs a CryptoKey.
const rawKey = await generateKey();
const key = await importKey(rawKey);
const blob = await encryptBlob(compressed, key);

// Merkle root over the batch (streaming, O(log N) memory).
// Pass a 32-byte per-batch secret to get SALTED leaves so the public root can't be
// brute-forced from low-entropy receipt fields. Store the secret with the encrypted
// blob; without it the salted proofs cannot be rebuilt.
const batchSecret = randomBytes(32);
const root = buildReceiptRoot(receipts, batchSecret); // 32-byte Buffer; omit batchSecret for the unsalted root

// Check that a receipt is in the batch (a salted tree's proofs carry their per-leaf salt)
const proof = new MerkleTree(receipts, batchSecret).proof(42);
const included = verifyReceiptInBatch(receipts[42], proof);

// Anchor instruction data for one 32-byte commitment: [0x01][0x00][32 bytes] = 34 bytes.
// There is no default program: resolveReceiptAnchorProgramId() throws
// RECEIPT_ANCHOR_UNAVAILABLE unless you name a receipt_anchor deployment
// (devnet: HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs).
const programId = resolveReceiptAnchorProgramId(process.env.RECEIPT_ANCHOR_PROGRAM_ID);
const ixData = buildAnchorIxData(new Uint8Array(root));
// Build and send the transaction yourself; this package sends nothing.
```

## What it does

| Feature | Detail |
|---|---|
| **Columnar compression** | Delta, dictionary and raw-string column encodings, DEFLATE per column. On the package's synthetic test batches (two senders, one receiver, ten distinct amounts, sequential timestamps) the test run prints 66.1x for 1,000 receipts and 62.4x for 500; the test asserts more than 10x. Receipts with more distinct values compress less |
| **Exact round trip** | For integer and string fields present on every receipt. Non-integer numbers throw; `bigint` above 2^53 loses precision; a missing key is filled in |
| **Bilateral netting** | One net balance per counterparty pair, gross flows netted against the reverse direction. The number of entries depends on the number of pairs, not the number of receipts: N agents have at most N(N-1)/2 pairs (4,950 for 100 agents). Pure arithmetic; not signed or enforced |
| **AES-256-GCM** | WebCrypto with a random 12-byte nonce, opt-in, under a key the caller manages; no key exchange |
| **Merkle commitment** | RFC 6962 style leaf and node prefixes. A batch of any size reduces to one 32-byte root; the root commits to the receipts and does not contain them |
| **Salted hiding leaves** | Per-leaf salt (HKDF from a per-batch secret) blinds the public root, so low-entropy receipt fields can't be brute-forced from the on-chain commitment |
| **Inclusion proofs** | Anyone holding a receipt and its proof can check it against the root |
| **Anchor instruction** | Builds instruction bytes for a `receipt_anchor` deployment the caller names. No transaction is built or sent, and no tokens move |

## Compression algorithm

Based on [Liquefy](https://github.com/Parad0x-Labs/liquefy-openclaw-integration) Columnar Gun v1:
- Transpose array-of-receipts into columns
- Delta encode numerics (amounts, timestamps)
- Dictionary encode low-cardinality strings (receivers, program IDs)
- Deflate each column independently
- A receiver repeated across 1,000 receipts is stored once

## On-chain programs

This package has no default `receipt_anchor` program. `RECEIPT_ANCHOR_PROGRAM_ID` is `null` and
`resolveReceiptAnchorProgramId()` throws `RECEIPT_ANCHOR_UNAVAILABLE` unless you pass a program ID. The devnet
`receipt_anchor` program is `HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs`. The program folds each 32-byte value into an hourly hash chain; showing that one
receipt was anchored needs its Merkle proof plus the ordered anchors in that bucket.

## License

MIT, [Parad0x Labs](https://github.com/Parad0x-Labs)
