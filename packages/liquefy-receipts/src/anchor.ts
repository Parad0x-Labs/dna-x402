/**
 * Build the receipt_anchor on-chain instruction for a compressed batch.
 *
 * The receipt_anchor program (6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN,
 * live on Solana mainnet-beta) stores an arbitrary payload on-chain.
 * We use it to anchor the compressed+encrypted batch receipt.
 *
 * One tx per epoch = 1000× cheaper than one tx per receipt.
 */

import { createHash } from "node:crypto";

export const RECEIPT_ANCHOR_PROGRAM_ID = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";

export interface BatchAnchorPayload {
  /** The compressed (+ optionally encrypted) receipt batch bytes. */
  batchBytes:   Uint8Array;
  /** Number of receipts in the batch. */
  receiptCount: number;
  /** Epoch identifier (e.g. Unix day: Math.floor(Date.now() / 86400_000)) */
  epochId:      number;
  /** Whether batchBytes is encrypted. */
  encrypted:    boolean;
}

/**
 * Build the instruction data for a single anchor.
 *
 * Layout: [0x01][0x00][32 bytes SHA-256 commitment] = 34 bytes total
 */
export function buildAnchorIxData(commitment32: Uint8Array): Uint8Array {
  if (commitment32.length !== 32) {
    throw new RangeError(`commitment32 must be exactly 32 bytes, got ${commitment32.length}`);
  }
  const out = new Uint8Array(34);
  out[0] = 0x01;
  out[1] = 0x00;
  out.set(commitment32, 2);
  return out;
}

/**
 * Build the instruction data for a batch anchor.
 *
 * Layout: [0x01][count N][N × 32 bytes commitments] = 2 + N*32 bytes
 * Count must be between 2 and 32 inclusive.
 */
export function buildAnchorBatchIxData(commitments: Uint8Array[]): Uint8Array {
  const count = commitments.length;
  if (count < 2 || count > 32) {
    throw new RangeError(`batch size must be 2–32, got ${count}`);
  }
  for (let i = 0; i < count; i++) {
    if (commitments[i].length !== 32) {
      throw new RangeError(`commitment[${i}] must be exactly 32 bytes, got ${commitments[i].length}`);
    }
  }
  const out = new Uint8Array(2 + count * 32);
  out[0] = 0x01;
  out[1] = count;
  for (let i = 0; i < count; i++) {
    out.set(commitments[i], 2 + i * 32);
  }
  return out;
}

/** SHA-256 of the batch bytes — use as the anchor's unique identifier. */
export function batchHash(batchBytes: Uint8Array): string {
  return createHash("sha256").update(batchBytes).digest("hex");
}
