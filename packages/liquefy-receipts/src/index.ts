/**
 * @parad0x_labs/liquefy-receipts
 *
 * Columnar compression + bilateral netting + AES-256-GCM encryption
 * for x402 payment receipt batches.
 *
 * 1000 receipts → 1 on-chain anchor tx.
 * Anchors via a caller-named receipt_anchor deployment (no default; the devnet
 * receipt_anchor is HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs).
 *
 * Based on Liquefy Columnar Gun v1 algorithm (github.com/Parad0x-Labs/liquefy-openclaw-integration)
 * ported to TypeScript.
 */

export { compressReceipts, decompressReceipts }  from "./compress.js";
export type { X402Receipt }                       from "./compress.js";
export { netReceipts }                            from "./net.js";
export type { NetSettlement }                     from "./net.js";
export { importKey, generateKey, encryptBlob, decryptBlob, serializeBlob, deserializeBlob } from "./encrypt.js";
export type { EncryptedBlob }                     from "./encrypt.js";
export {
  buildAnchorIxData,
  batchHash,
  RECEIPT_ANCHOR_PROGRAM_ID,
  RECEIPT_ANCHOR_UNAVAILABLE,
  resolveReceiptAnchorProgramId,
} from "./anchor.js";
export type { BatchAnchorPayload }                from "./anchor.js";
export {
  StreamingMerkleBuilder,
  MerkleTree,
  buildReceiptRoot,
  verifyProof,
  verifyReceiptInBatch,
  rootHex,
  hashLeafBytes,
  hashInternal,
  hashSaltedLeaf,
  deriveLeafSalt,
  canonicalReceiptBytes,
  LEAF_SALT_BYTES,
} from "./merkle.js";
export type { MerkleProof } from "./merkle.js";
