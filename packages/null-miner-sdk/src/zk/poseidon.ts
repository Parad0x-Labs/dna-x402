/**
 * null-miner-sdk — BN254 Poseidon hash utilities
 *
 * Poseidon (Grassi, Khovratovich, Rechberger, Roy, Schofnegger 2019) is the
 * ZK-native hash function: ~240 R1CS constraints vs ~28K for SHA-256.
 * Every serious ZK project migrated after the 2019 paper. Semaphore, Tornado
 * Cash, Aztec, Polygon Hermez, StarkNet — all Poseidon.
 *
 * Solana has a `sol_poseidon` syscall for BN254 Poseidon (t=2..13).
 * This module runs **off-chain** to build commitments, nullifiers, and Merkle
 * paths that are later verified by programs/dark_bn254_gate on-chain.
 *
 * BN254 scalar field modulus (= group order r):
 *   p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 *
 * All outputs are field elements in Z_p (bigint) or their 32-byte BE encodings.
 */

import { poseidon2 }   from "poseidon-lite";
import { createHash }  from "crypto";

// ── BN254 Scalar Field ─────────────────────────────────────────────────────────

/** BN254 scalar field modulus (group order r). */
export const BN254_FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Reduce x to the BN254 scalar field (handles negative values). */
export function fieldMod(x: bigint): bigint {
  return ((x % BN254_FIELD_P) + BN254_FIELD_P) % BN254_FIELD_P;
}

/** Convert a 32-byte big-endian buffer/Uint8Array to a BN254 field element. */
export function bytesToField(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return fieldMod(n);
}

/** Encode a BN254 field element as a 32-byte big-endian Buffer. */
export function fieldToBytes(n: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = fieldMod(n);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Decode a 64-char hex string to a BN254 field element. */
export function hexToField(hex: string): bigint {
  return bytesToField(Buffer.from(hex.padStart(64, "0"), "hex"));
}

/** Encode a BN254 field element as a 64-char lowercase hex string. */
export function fieldToHex(n: bigint): string {
  return fieldToBytes(n).toString("hex");
}

// ── Poseidon Hash ──────────────────────────────────────────────────────────────

/**
 * Poseidon2: hash two BN254 field elements.
 *
 * This is the Semaphore primitive:
 *   identityCommitment = poseidonHash2(nullifier, trapdoor)
 *   nullifierHash(ctx) = poseidonHash2(nullifier, externalNullifier)
 *
 * @example
 * const commitment = poseidonHash2(nullifierField, trapdoorField);
 */
export function poseidonHash2(a: bigint, b: bigint): bigint {
  return poseidon2([fieldMod(a), fieldMod(b)]);
}

/**
 * Poseidon2 on hex string pair — convenience wrapper.
 * Returns 64-char hex.
 */
export function poseidonHashHex(hexA: string, hexB: string): string {
  return fieldToHex(poseidonHash2(hexToField(hexA), hexToField(hexB)));
}

/**
 * Poseidon Merkle node hash: H(left, right) for a depth-20 Semaphore tree.
 * Both inputs are 32-byte BE buffers; output is a 32-byte BE buffer.
 */
export function poseidonMerkleHash(left: Buffer, right: Buffer): Buffer {
  return fieldToBytes(poseidonHash2(bytesToField(left), bytesToField(right)));
}

// ── Domain-Separated SHA-256 Field Element ─────────────────────────────────────

/**
 * Derive a BN254 field element by SHA-256 hashing a domain string + inputs.
 * Used when bridging the existing SHA-256 identity layer with the Poseidon ZK layer.
 *
 * Output = bytesToField(SHA-256(domain_bytes || ...inputs))
 */
export function sha256Field(domain: string, ...inputs: Buffer[]): bigint {
  const h = createHash("sha256").update(Buffer.from(domain));
  for (const inp of inputs) h.update(inp);
  return bytesToField(h.digest());
}
