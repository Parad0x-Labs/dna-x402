/**
 * Layer: Fee commitment / reveal data contract
 *
 * TypeScript mirror of the `dark-fee-commitment` Rust crate format.
 * Tests commitment hash derivation, determinism, nonce binding, and
 * reveal verification logic.
 *
 * No source imports needed. All commitment functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-fee-commitment Rust crate
// ---------------------------------------------------------------------------

/**
 * Computes a 32-byte fee commitment hash.
 * Domain-separated with "fee-commit-v1".
 *
 * amount is encoded as a 16-byte little-endian unsigned integer (u128 LE)
 * to match the Rust crate layout.
 */
function feeCommitmentHash(amount: bigint, nonce: Buffer): Buffer {
  const amountBuf = Buffer.alloc(16, 0);
  // Write as two 64-bit LE halves (low 64 bits, high 64 bits)
  amountBuf.writeBigUInt64LE(amount & 0xffff_ffff_ffff_ffffn, 0);
  amountBuf.writeBigUInt64LE(amount >> 64n, 8);

  return createHash("sha256")
    .update("fee-commit-v1")
    .update(amountBuf)
    .update(nonce)
    .digest();
}

interface FeeCommitment {
  commitmentHash: Buffer; // 32-byte commitment
  epoch: bigint;          // epoch the commitment belongs to
}

function newFeeCommitment(amount: bigint, nonce: Buffer, epoch: bigint): FeeCommitment {
  return {
    commitmentHash: feeCommitmentHash(amount, nonce),
    epoch,
  };
}

/**
 * Reveal: recomputes the commitment from the revealed (amount, nonce) pair
 * and checks it matches the stored commitment.
 */
function revealFeeCommitment(
  commitment: FeeCommitment,
  revealedAmount: bigint,
  revealedNonce: Buffer,
): boolean {
  const recomputed = feeCommitmentHash(revealedAmount, revealedNonce);
  return recomputed.equals(commitment.commitmentHash);
}

/**
 * Commitment JSON — exposes the commitment_hash and epoch for
 * verifiability but intentionally omits the raw amount.
 */
function commitmentJson(commitment: FeeCommitment): string {
  return JSON.stringify({
    commitment_hash: commitment.commitmentHash.toString("hex"),
    epoch: commitment.epoch.toString(),
    // raw amount is intentionally absent
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fee commitment / reveal data contract", () => {
  const NONCE       = createHash("sha256").update("test-nonce-fixture").digest();
  const TEST_AMOUNT = 500_000n;

  it("commitment hash = SHA256('fee-commit-v1' || amount_le_bytes || nonce) — 32 bytes", () => {
    const hash = feeCommitmentHash(TEST_AMOUNT, NONCE);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
    expect(hash.toString("hex")).toHaveLength(64);
    expect(hash.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("zero amount yields different hash than non-zero amount", () => {
    const hashZero    = feeCommitmentHash(0n, NONCE);
    const hashNonZero = feeCommitmentHash(TEST_AMOUNT, NONCE);
    expect(hashZero.equals(hashNonZero)).toBe(false);
  });

  it("same amount + nonce → same commitment hash (deterministic)", () => {
    const hash1 = feeCommitmentHash(TEST_AMOUNT, NONCE);
    const hash2 = feeCommitmentHash(TEST_AMOUNT, NONCE);
    expect(hash1.equals(hash2)).toBe(true);
  });

  it("different nonce → different commitment hash", () => {
    const nonce2 = createHash("sha256").update("different-nonce-fixture").digest();
    const hash1  = feeCommitmentHash(TEST_AMOUNT, NONCE);
    const hash2  = feeCommitmentHash(TEST_AMOUNT, nonce2);
    expect(hash1.equals(hash2)).toBe(false);
  });

  it("reveal with matching amount + nonce → recomputed hash matches commitment", () => {
    const commitment = newFeeCommitment(TEST_AMOUNT, NONCE, 42n);
    expect(revealFeeCommitment(commitment, TEST_AMOUNT, NONCE)).toBe(true);
  });

  it("reveal with wrong amount → recomputed hash does NOT match commitment", () => {
    const commitment = newFeeCommitment(TEST_AMOUNT, NONCE, 42n);
    expect(revealFeeCommitment(commitment, TEST_AMOUNT + 1n, NONCE)).toBe(false);
  });

  it("commitment_json contains commitment_hash and epoch but NOT the amount as a decimal string", () => {
    const commitment = newFeeCommitment(TEST_AMOUNT, NONCE, 7n);
    const json = commitmentJson(commitment);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("commitment_hash");
    expect(parsed).toHaveProperty("epoch");
    // The raw decimal amount must not appear in the JSON
    expect(json).not.toContain(TEST_AMOUNT.toString(10));
  });
});
