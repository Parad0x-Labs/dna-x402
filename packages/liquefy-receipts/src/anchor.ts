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
 * Build the instruction data for the receipt_anchor program.
 *
 * Layout:
 *   [discriminant 1B = 0x42 "batch"]
 *   [epochId 4B LE]
 *   [receiptCount 4B LE]
 *   [flags 1B: bit0 = encrypted]
 *   [batchHash 32B SHA-256 of batchBytes]
 *   [batchLen 4B LE]
 *   [batchBytes]
 */
export function buildAnchorIxData(p: BatchAnchorPayload): Uint8Array {
  const hash = new Uint8Array(
    Buffer.from(createHash("sha256").update(p.batchBytes).digest())
  );
  const total = 1 + 4 + 4 + 1 + 32 + 4 + p.batchBytes.length;
  const out   = new Uint8Array(total);
  const dv    = new DataView(out.buffer);
  let off     = 0;

  out[off++]  = 0x42; // discriminant "batch"
  dv.setUint32(off, p.epochId, true);     off += 4;
  dv.setUint32(off, p.receiptCount, true); off += 4;
  out[off++]  = p.encrypted ? 0x01 : 0x00;
  out.set(hash, off); off += 32;
  dv.setUint32(off, p.batchBytes.length, true); off += 4;
  out.set(p.batchBytes, off);

  return out;
}

/** SHA-256 of the batch bytes — use as the anchor's unique identifier. */
export function batchHash(batchBytes: Uint8Array): string {
  return createHash("sha256").update(batchBytes).digest("hex");
}
