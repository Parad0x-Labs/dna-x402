/**
 * @dna-x402/liquefy-receipts
 *
 * Columnar compression + bilateral netting + AES-256-GCM encryption
 * for x402 payment receipt batches.
 *
 * 1000 receipts → 1 on-chain anchor tx.
 * Uses receipt_anchor (6HSRGivd…) already live on Solana mainnet-beta.
 *
 * Based on Liquefy Columnar Gun v1 algorithm (github.com/Parad0x-Labs/liquefy)
 * ported to TypeScript.
 */

export { compressReceipts, decompressReceipts }  from "./compress.js";
export type { X402Receipt }                       from "./compress.js";
export { netReceipts }                            from "./net.js";
export type { NetSettlement }                     from "./net.js";
export { importKey, generateKey, encryptBlob, decryptBlob, serializeBlob, deserializeBlob } from "./encrypt.js";
export type { EncryptedBlob }                     from "./encrypt.js";
export { buildAnchorIxData, batchHash, RECEIPT_ANCHOR_PROGRAM_ID } from "./anchor.js";
export type { BatchAnchorPayload }                from "./anchor.js";
