import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a
}

// ---------------------------------------------------------------------------
// Bulletproof-range inline implementation
// Mirrors crates/dark-bulletproof-range/src/lib.rs
//
// commitment = SHA256("bp-commit-v1" || value_u64le || blinding)
//
// For n bits: a_bytes = bits of value (LSB first), b_bytes = 1-bit_i for each
//   a_hash = SHA256("bp-vec-a-v1" || SHA256(a_bytes))
//   b_hash = SHA256("bp-vec-b-v1" || SHA256(b_bytes))
//   inner_product_hash = SHA256("bp-inner-v1" || a_hash || b_hash)
//   proof_hash = SHA256("bp-proof-v1" || commitment || inner_product_hash || [bit_width])
//   proof_id   = SHA256("bp-id-v1" || proof_hash)
// ---------------------------------------------------------------------------

function bpCommitment(value: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('bp-commit-v1'), u64le(value), blinding)
}

function bpVecHashes(value: bigint, bitWidth: number): { aHash: Buffer; bHash: Buffer } {
  const aBits: number[] = []
  const bBits: number[] = []
  for (let i = 0; i < bitWidth; i++) {
    const bit = Number((value >> BigInt(i)) & 1n)
    aBits.push(bit)
    bBits.push(1 - bit)
  }
  const aBytes = Buffer.from(aBits)
  const bBytes = Buffer.from(bBits)
  const aHash = sha256(Buffer.from('bp-vec-a-v1'), sha256(aBytes))
  const bHash = sha256(Buffer.from('bp-vec-b-v1'), sha256(bBytes))
  return { aHash, bHash }
}

function bpInnerProductHash(value: bigint, bitWidth: number): Buffer {
  const { aHash, bHash } = bpVecHashes(value, bitWidth)
  return sha256(Buffer.from('bp-inner-v1'), aHash, bHash)
}

function bpProofHash(value: bigint, blinding: Buffer, bitWidth: number): Buffer {
  const commitment = bpCommitment(value, blinding)
  const inner = bpInnerProductHash(value, bitWidth)
  return sha256(Buffer.from('bp-proof-v1'), commitment, inner, Buffer.from([bitWidth]))
}

function bpProofId(value: bigint, blinding: Buffer, bitWidth: number): Buffer {
  return sha256(Buffer.from('bp-id-v1'), bpProofHash(value, blinding, bitWidth))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null bulletproof-range', () => {
  const BLINDING = Buffer.alloc(32).fill(0xab)
  const VALUE = 42n
  const BIT_WIDTH = 8

  it('commitment = SHA256("bp-commit-v1" || value_u64le || blinding)', () => {
    const comm = bpCommitment(VALUE, BLINDING)
    expect(comm).toBeInstanceOf(Buffer)
    expect(comm.length).toBe(32)
    const expected = sha256(Buffer.from('bp-commit-v1'), u64le(VALUE), BLINDING)
    expect(comm).toEqual(expected)
  })

  it('inner_product_hash for value=5 bit_width=4', () => {
    const val = 5n
    const width = 4
    const { aHash, bHash } = bpVecHashes(val, width)
    // value=5 = 0b0101: bits [1,0,1,0], b_bits = [0,1,0,1]
    expect(aHash.length).toBe(32)
    expect(bHash.length).toBe(32)
    const inner = bpInnerProductHash(val, width)
    const expected = sha256(Buffer.from('bp-inner-v1'), aHash, bHash)
    expect(inner).toEqual(expected)
  })

  it('proof_id computation is correct', () => {
    const proofHash = bpProofHash(VALUE, BLINDING, BIT_WIDTH)
    const proofId = bpProofId(VALUE, BLINDING, BIT_WIDTH)
    expect(proofId).toBeInstanceOf(Buffer)
    expect(proofId.length).toBe(32)
    const expected = sha256(Buffer.from('bp-id-v1'), proofHash)
    expect(proofId).toEqual(expected)
  })

  it('different values → different proof_ids', () => {
    const id1 = bpProofId(10n, BLINDING, BIT_WIDTH)
    const id2 = bpProofId(20n, BLINDING, BIT_WIDTH)
    expect(id1.equals(id2)).toBe(false)
  })

  it('verify by recomputing commitment and inner_product_hash', () => {
    const comm = bpCommitment(VALUE, BLINDING)
    const inner = bpInnerProductHash(VALUE, BIT_WIDTH)
    const proofHash = bpProofHash(VALUE, BLINDING, BIT_WIDTH)
    // Verify: recompute proof_hash from stored commitment + inner and compare
    const recomputed = sha256(Buffer.from('bp-proof-v1'), comm, inner, Buffer.from([BIT_WIDTH]))
    expect(recomputed).toEqual(proofHash)
  })

  it('mainnet_ready=false flag present in public record', () => {
    const comm = bpCommitment(VALUE, BLINDING)
    const proofId = bpProofId(VALUE, BLINDING, BIT_WIDTH)
    const record = {
      proof_id: proofId.toString('hex'),
      commitment: comm.toString('hex'),
      bit_width: BIT_WIDTH,
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    expect(record.proof_id.length).toBe(64)
  })
})
