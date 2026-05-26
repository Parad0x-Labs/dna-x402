import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u8(n: number): Buffer { return Buffer.from([n]) }
function xor(a: Buffer, b: Buffer): Buffer { return Buffer.from(a.map((byte, i) => byte ^ b[i])) }

// ---------------------------------------------------------------------------
// ZKP Bulletproof primitives (mirrors crates/dark-zkp-bulletproof/src/lib.rs)
//
// commitment        = SHA256("bp-commit-v1"  || value_le[8] || blinding[32])
// inner_product_hash= SHA256("bp-inner-v1"   || commitment  || value_le[8])
// verify_hash       = SHA256("bp-verify-v1"  || inner_product_hash || commitment)
// ---------------------------------------------------------------------------

const MAX_BITS: Record<number, bigint> = {
  8:  255n,
  16: 65535n,
  32: 4294967295n,
  64: 18446744073709551615n,
}

function bp_commitment(value: bigint, blinding: Buffer): Buffer {
  if (blinding.equals(Buffer.alloc(blinding.length, 0))) {
    throw new Error('ZeroBlinding')
  }
  return sha256(Buffer.from('bp-commit-v1'), u64le(value), blinding)
}

function bp_inner_product_hash(commitment: Buffer, value: bigint): Buffer {
  return sha256(Buffer.from('bp-inner-v1'), commitment, u64le(value))
}

function bp_verify_hash(inner: Buffer, commitment: Buffer): Buffer {
  return sha256(Buffer.from('bp-verify-v1'), inner, commitment)
}

interface BulletProof {
  commitment:          Buffer
  inner_product_hash:  Buffer
  verify_hash:         Buffer
  bit_size:            number
  value:               bigint   // kept private in practice; here for test verification
}

function prove(value: bigint, blinding: Buffer, bit_size: number): BulletProof {
  const maxVal = MAX_BITS[bit_size]
  if (maxVal === undefined) throw new Error('UnsupportedBitSize')
  if (value > maxVal) throw new Error('OutOfRange')
  const cm   = bp_commitment(value, blinding)
  const iph  = bp_inner_product_hash(cm, value)
  const vh   = bp_verify_hash(iph, cm)
  return { commitment: cm, inner_product_hash: iph, verify_hash: vh, bit_size, value }
}

function verify(proof: BulletProof): boolean {
  // Recompute verify_hash from the stored commitment and inner_product_hash
  const expected_iph = bp_inner_product_hash(proof.commitment, proof.value)
  if (!expected_iph.equals(proof.inner_product_hash)) return false
  const expected_vh = bp_verify_hash(expected_iph, proof.commitment)
  return expected_vh.equals(proof.verify_hash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zkp-bulletproof', () => {
  const BLINDING_A = Buffer.alloc(32).fill(0xa0)
  const BLINDING_B = Buffer.alloc(32).fill(0xb0)

  it('8-bit proof (value=100) is valid', () => {
    const proof = prove(100n, BLINDING_A, 8)
    expect(proof.commitment.length).toBe(32)
    expect(proof.inner_product_hash.length).toBe(32)
    expect(proof.verify_hash.length).toBe(32)
    expect(verify(proof)).toBe(true)
  })

  it('16-bit proof (value=1000) is valid', () => {
    const proof = prove(1000n, BLINDING_A, 16)
    expect(verify(proof)).toBe(true)
  })

  it('out-of-range rejected (256 for 8-bit)', () => {
    expect(() => prove(256n, BLINDING_A, 8)).toThrow('OutOfRange')
    // 255 is the max for 8-bit and must succeed
    expect(() => prove(255n, BLINDING_A, 8)).not.toThrow()
  })

  it('zero blinding rejected', () => {
    const zeroBlinding = Buffer.alloc(32, 0)
    expect(() => prove(100n, zeroBlinding, 8)).toThrow('ZeroBlinding')
  })

  it('verify passes on well-formed proof', () => {
    const proof = prove(42n, BLINDING_B, 8)
    expect(verify(proof)).toBe(true)

    // Tamper verify_hash → verify fails
    const tampered: BulletProof = { ...proof, verify_hash: Buffer.alloc(32).fill(0xff) }
    expect(verify(tampered)).toBe(false)

    // Tamper inner_product_hash → verify fails
    const tampered2: BulletProof = { ...proof, inner_product_hash: Buffer.alloc(32).fill(0xee) }
    expect(verify(tampered2)).toBe(false)
  })

  it('different values produce different commitments', () => {
    const proof_a = prove(10n, BLINDING_A, 8)
    const proof_b = prove(20n, BLINDING_A, 8)

    expect(proof_a.commitment.equals(proof_b.commitment)).toBe(false)
    expect(proof_a.verify_hash.equals(proof_b.verify_hash)).toBe(false)
  })
})
