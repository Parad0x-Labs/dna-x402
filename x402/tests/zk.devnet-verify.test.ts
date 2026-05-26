/**
 * Layer: ZK devnet withdraw-instruction data format
 *
 * Tests the 352-byte withdraw instruction data layout used by the on-chain
 * verifier program on devnet. The layout is:
 *
 *   [0..256)   proof  — A:64  B:128  C:64
 *   [256..288) merkle_root  — 32 bytes
 *   [288..320) nullifier    — 32 bytes
 *   [320..352) amount       — 32 bytes (LE u64 in first 8, rest zero)
 *
 * No source imports needed. The helper function is implemented inline.
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline helper — mirrors the Rust serialisation in dark_nullifier_banks
// ---------------------------------------------------------------------------

/**
 * Builds the 352-byte withdraw instruction data buffer.
 *
 * @param proof      256-byte Groth16 proof  (A:64 + B:128 + C:64)
 * @param root       32-byte merkle root
 * @param nullifier  32-byte nullifier hash
 * @param amount     payment amount as bigint (u64)
 */
function buildWithdrawInstructionData(
  proof: Buffer,
  root: Buffer,
  nullifier: Buffer,
  amount: bigint
): Buffer {
  if (proof.length !== 256) throw new Error(`proof must be 256 bytes, got ${proof.length}`);
  if (root.length !== 32) throw new Error(`root must be 32 bytes`);
  if (nullifier.length !== 32) throw new Error(`nullifier must be 32 bytes`);

  const out = Buffer.alloc(352, 0);
  proof.copy(out, 0);      // [0..256)
  root.copy(out, 256);     // [256..288)
  nullifier.copy(out, 288); // [288..320)

  // amount as LE u64 in bytes [320..328), rest remain zero
  out.writeBigUInt64LE(amount, 320);

  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProof(sentinelByte0 = 0x00, sentinelByte1 = 0x00): Buffer {
  const buf = Buffer.alloc(256, 0xab);
  buf[0] = sentinelByte0;
  buf[1] = sentinelByte1;
  return buf;
}

const DEVNET_ROOT = Buffer.alloc(32, 0x11);
const DEVNET_NULLIFIER_A = Buffer.alloc(32, 0x22);
const DEVNET_NULLIFIER_B = Buffer.alloc(32, 0x33);
const DEVNET_AMOUNT = 5_000_000n; // 5 USDC in atomic units

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("zk devnet withdraw instruction data format", () => {
  it("instruction data is exactly 352 bytes", () => {
    const data = buildWithdrawInstructionData(
      makeProof(),
      DEVNET_ROOT,
      DEVNET_NULLIFIER_A,
      DEVNET_AMOUNT
    );
    expect(data.length).toBe(352);
  });

  it("first 256 bytes are the proof (A:64 + B:128 + C:64)", () => {
    const proof = makeProof(0xaa, 0xbb);
    const data = buildWithdrawInstructionData(proof, DEVNET_ROOT, DEVNET_NULLIFIER_A, DEVNET_AMOUNT);
    const proofSlice = data.subarray(0, 256);
    expect(proofSlice.equals(proof)).toBe(true);
  });

  it("bytes 256-287 are merkle_root (32 bytes)", () => {
    const data = buildWithdrawInstructionData(
      makeProof(),
      DEVNET_ROOT,
      DEVNET_NULLIFIER_A,
      DEVNET_AMOUNT
    );
    const root = data.subarray(256, 288);
    expect(root.equals(DEVNET_ROOT)).toBe(true);
  });

  it("bytes 288-319 are nullifier (32 bytes)", () => {
    const data = buildWithdrawInstructionData(
      makeProof(),
      DEVNET_ROOT,
      DEVNET_NULLIFIER_A,
      DEVNET_AMOUNT
    );
    const nullifier = data.subarray(288, 320);
    expect(nullifier.equals(DEVNET_NULLIFIER_A)).toBe(true);
  });

  it("bytes 320-351 are amount (32 bytes, LE u64 in first 8, rest zero)", () => {
    const amount = 12_345_678n;
    const data = buildWithdrawInstructionData(makeProof(), DEVNET_ROOT, DEVNET_NULLIFIER_A, amount);
    const amountSlice = data.subarray(320, 352);

    // First 8 bytes encode the amount as little-endian u64
    const decoded = amountSlice.readBigUInt64LE(0);
    expect(decoded).toBe(amount);

    // Remaining 24 bytes must be zero
    const tail = amountSlice.subarray(8, 32);
    expect(tail.every((b) => b === 0)).toBe(true);
  });

  it("devnet test proof has sentinel bytes 0xDE at index 0, 0xAD at index 1", () => {
    const devnetTestProof = makeProof(0xde, 0xad);
    const data = buildWithdrawInstructionData(
      devnetTestProof,
      DEVNET_ROOT,
      DEVNET_NULLIFIER_A,
      DEVNET_AMOUNT
    );
    expect(data[0]).toBe(0xde);
    expect(data[1]).toBe(0xad);
  });

  it("different nullifiers produce different instruction data (bytes 288-319 differ)", () => {
    const dataA = buildWithdrawInstructionData(makeProof(), DEVNET_ROOT, DEVNET_NULLIFIER_A, DEVNET_AMOUNT);
    const dataB = buildWithdrawInstructionData(makeProof(), DEVNET_ROOT, DEVNET_NULLIFIER_B, DEVNET_AMOUNT);

    const nullSliceA = dataA.subarray(288, 320);
    const nullSliceB = dataB.subarray(288, 320);

    expect(nullSliceA.equals(nullSliceB)).toBe(false);

    // Bytes outside the nullifier range must be identical (same proof / root / amount)
    expect(dataA.subarray(0, 288).equals(dataB.subarray(0, 288))).toBe(true);
    expect(dataA.subarray(320, 352).equals(dataB.subarray(320, 352))).toBe(true);
  });
});
