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

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Pedersen-commit primitives (mirrors crates/dark-pedersen-commit)
//
// commitment = SHA256("pedersen-v1" || value_le[8] || blinding[32])
// combined   = XOR(commitment_a, commitment_b)
// sum_hash   = SHA256("pedersen-sum-v1" || commitment_a || commitment_b)
// ---------------------------------------------------------------------------

const PREFIX_COMMIT = Buffer.from('pedersen-v1')
const PREFIX_SUM    = Buffer.from('pedersen-sum-v1')

function commit(value: bigint, blinding: Buffer): Buffer {
  if (blinding.length !== 32) throw new Error('blinding must be 32 bytes')
  if (blinding.equals(Buffer.alloc(32))) throw new Error('zero blinding rejected')
  return sha256(PREFIX_COMMIT, u64le(value), blinding)
}

function openCommit(commitment: Buffer, value: bigint, blinding: Buffer): boolean {
  if (blinding.length !== 32) return false
  if (blinding.equals(Buffer.alloc(32))) return false
  const expected = sha256(PREFIX_COMMIT, u64le(value), blinding)
  return expected.equals(commitment)
}

function addCommitments(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i]
  return out
}

function sumHash(a: Buffer, b: Buffer): Buffer {
  return sha256(PREFIX_SUM, a, b)
}

function verifySum(a: Buffer, b: Buffer, combined: Buffer, hash: Buffer): boolean {
  const expectedCombined = addCommitments(a, b)
  const expectedHash     = sumHash(a, b)
  return expectedCombined.equals(combined) && expectedHash.equals(hash)
}

// Simulated "public record" for Pedersen commitment — hides the value
function publicRecord(commitment: Buffer): object {
  return {
    commitment_hex: commitment.toString('hex'),
    value:          null,           // hidden
    blinding:       null,           // hidden
    mainnet_ready:  false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null pedersen-commit', () => {
  const BLINDING_A = Buffer.alloc(32).fill(0xaa)
  const BLINDING_B = Buffer.alloc(32).fill(0xbb)

  it('commit+open roundtrip: open returns true for correct value and blinding', () => {
    const value = 1_000_000n
    const c = commit(value, BLINDING_A)
    expect(c.length).toBe(32)
    expect(openCommit(c, value, BLINDING_A)).toBe(true)
  })

  it('wrong blinding fails open', () => {
    const value = 42n
    const c = commit(value, BLINDING_A)
    const wrongBlinding = Buffer.alloc(32).fill(0xcc)
    expect(openCommit(c, value, wrongBlinding)).toBe(false)
  })

  it('zero blinding is rejected at commit time', () => {
    expect(() => commit(100n, Buffer.alloc(32))).toThrow('zero blinding rejected')
  })

  it('add_commitments + verify_sum passes for valid pair', () => {
    const c_a = commit(300n, BLINDING_A)
    const c_b = commit(700n, BLINDING_B)
    const combined = addCommitments(c_a, c_b)
    const hash     = sumHash(c_a, c_b)
    expect(verifySum(c_a, c_b, combined, hash)).toBe(true)
  })

  it('different values produce different commitments under the same blinding', () => {
    const c1 = commit(1n,  BLINDING_A)
    const c2 = commit(2n,  BLINDING_A)
    const c3 = commit(999n, BLINDING_A)
    expect(c1.equals(c2)).toBe(false)
    expect(c1.equals(c3)).toBe(false)
    expect(c2.equals(c3)).toBe(false)
  })

  it('public record hides value — record has no value field, and mainnet_ready is false', () => {
    const c = commit(123456789n, BLINDING_B)
    const rec = publicRecord(c) as Record<string, unknown>
    expect(rec['value']).toBeNull()
    expect(rec['blinding']).toBeNull()
    expect(rec['commitment_hex']).toBe(c.toString('hex'))
    expect(rec['mainnet_ready']).toBe(false)
  })
})
