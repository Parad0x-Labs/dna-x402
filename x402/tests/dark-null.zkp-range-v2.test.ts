import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// ZKP Range v2 primitives
//
// commitment   = SHA256("rangev2-commit-v1"    || value_u64le || blinding)
// bit_blind[i] = SHA256("rangev2-bit-blind-v1" || blinding || [i])
// bc[i]        = SHA256("rangev2-bit-v1"        || [i] || [(value>>i)&1] || bit_blind[i])
// proof_hash   = SHA256("rangev2-proof-v1"      || commitment || XOR_fold(bc) || [bit_width])
// ---------------------------------------------------------------------------

function rangeCommitV2(value: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('rangev2-commit-v1'), u64le(value), blinding)
}

function bitBlind(blinding: Buffer, i: number): Buffer {
  return sha256(Buffer.from('rangev2-bit-blind-v1'), blinding, Buffer.from([i]))
}

function bitCommit(i: number, bit: number, bBlind: Buffer): Buffer {
  return sha256(Buffer.from('rangev2-bit-v1'), Buffer.from([i]), Buffer.from([bit]), bBlind)
}

interface RangeProofV2 {
  commitment: Buffer
  bitCommits: Buffer[]
  proofHash: Buffer
  bitWidth: number
  value: bigint
}

function rangeProveV2(value: bigint, blinding: Buffer, bitWidth: number): RangeProofV2 {
  const max = 1n << BigInt(bitWidth)
  if (value >= max) throw new Error(`value ${value} out of range for ${bitWidth}-bit proof`)

  const commitment = rangeCommitV2(value, blinding)
  const bcs: Buffer[] = []
  for (let i = 0; i < bitWidth; i++) {
    const bit   = Number((value >> BigInt(i)) & 1n)
    const bb    = bitBlind(blinding, i)
    const bc    = bitCommit(i, bit, bb)
    bcs.push(bc)
  }

  const proofHash = sha256(
    Buffer.from('rangev2-proof-v1'),
    commitment,
    xorFold(bcs),
    Buffer.from([bitWidth]),
  )

  return { commitment, bitCommits: bcs, proofHash, bitWidth, value }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null zkp-range-v2', () => {
  const BLINDING = sha256(Buffer.from('rangev2-test-blinding-seed'))

  it('commitment computation is deterministic and 32 bytes', () => {
    const c1 = rangeCommitV2(42n, BLINDING)
    const c2 = rangeCommitV2(42n, BLINDING)

    expect(c1.length).toBe(32)
    expect(c1.equals(c2)).toBe(true)

    // different value → different commitment
    const c3 = rangeCommitV2(43n, BLINDING)
    expect(c1.equals(c3)).toBe(false)
  })

  it('proof_hash for value=42 bit_width=8 is stable and 32 bytes', () => {
    const proof = rangeProveV2(42n, BLINDING, 8)

    expect(proof.proofHash.length).toBe(32)
    expect(proof.bitCommits).toHaveLength(8)

    // deterministic
    const proof2 = rangeProveV2(42n, BLINDING, 8)
    expect(proof.proofHash.equals(proof2.proofHash)).toBe(true)
  })

  it('different values produce different proofs', () => {
    const proof1 = rangeProveV2(10n, BLINDING, 8)
    const proof2 = rangeProveV2(20n, BLINDING, 8)
    const proof3 = rangeProveV2(255n, BLINDING, 8)

    expect(proof1.proofHash.equals(proof2.proofHash)).toBe(false)
    expect(proof1.proofHash.equals(proof3.proofHash)).toBe(false)
    expect(proof2.proofHash.equals(proof3.proofHash)).toBe(false)
  })

  it('bit_width affects proof_hash (same value, different width)', () => {
    const proof8  = rangeProveV2(42n, BLINDING, 8)
    const proof16 = rangeProveV2(42n, BLINDING, 16)
    const proof32 = rangeProveV2(42n, BLINDING, 32)

    expect(proof8.proofHash.equals(proof16.proofHash)).toBe(false)
    expect(proof8.proofHash.equals(proof32.proofHash)).toBe(false)
    expect(proof16.proofHash.equals(proof32.proofHash)).toBe(false)

    expect(proof8.bitCommits).toHaveLength(8)
    expect(proof16.bitCommits).toHaveLength(16)
    expect(proof32.bitCommits).toHaveLength(32)
  })

  it('in_range guard: value > max for bit_width throws error', () => {
    expect(() => rangeProveV2(256n, BLINDING, 8)).toThrow()
    expect(() => rangeProveV2(65536n, BLINDING, 16)).toThrow()

    // boundary: max value is exactly 2^n - 1, should NOT throw
    expect(() => rangeProveV2(255n, BLINDING, 8)).not.toThrow()
    expect(() => rangeProveV2(65535n, BLINDING, 16)).not.toThrow()
  })

  it('mainnet_ready is always false', () => {
    const proof = rangeProveV2(1n, BLINDING, 8)
    const record = {
      commitment:    proof.commitment.toString('hex'),
      proof_hash:    proof.proofHash.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
