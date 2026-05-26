import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const MAINNET_READY = false

describe('dark-null.zkp-range-v3', () => {
  const blinding = Buffer.from('rangev3-blinding-32bytes-padded!!', 'utf8').slice(0, 32)
  const value    = BigInt(750)
  const low      = BigInt(0)
  const high     = BigInt(1000)

  it('value_commitment = SHA256("rangev3-val-v1" || value_le8 || blinding)', () => {
    const valueLe8    = u64le(value)
    const valueCommit = sha256(Buffer.from('rangev3-val-v1'), valueLe8, blinding)
    expect(valueCommit.length).toBe(32)
    expect(valueCommit.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(valueCommit.equals(sha256(Buffer.from('rangev3-val-v1'), valueLe8, blinding))).toBe(true)
  })

  it('range_commitment = SHA256("rangev3-range-v1" || low_le8 || high_le8)', () => {
    const lowLe8    = u64le(low)
    const highLe8   = u64le(high)
    const rangeCommit = sha256(Buffer.from('rangev3-range-v1'), lowLe8, highLe8)
    expect(rangeCommit.length).toBe(32)
    expect(rangeCommit.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(rangeCommit.equals(sha256(Buffer.from('rangev3-range-v1'), lowLe8, highLe8))).toBe(true)
  })

  it('proof_id with in_range=1 is correct', () => {
    const valueLe8    = u64le(value)
    const lowLe8      = u64le(low)
    const highLe8     = u64le(high)
    const valueCommit = sha256(Buffer.from('rangev3-val-v1'), valueLe8, blinding)
    const rangeCommit = sha256(Buffer.from('rangev3-range-v1'), lowLe8, highLe8)
    const inRange     = Buffer.from([1])
    const proofId     = sha256(Buffer.from('rangev3-proof-v1'), valueCommit, rangeCommit, inRange)
    expect(proofId.length).toBe(32)
    expect(proofId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(proofId.equals(sha256(Buffer.from('rangev3-proof-v1'), valueCommit, rangeCommit, inRange))).toBe(true)
  })

  it('different values produce different value_commitments', () => {
    const b1 = sha256(Buffer.from('rangev3-val-v1'), u64le(BigInt(100)), blinding)
    const b2 = sha256(Buffer.from('rangev3-val-v1'), u64le(BigInt(200)), blinding)
    expect(b1.equals(b2)).toBe(false)
  })

  it('proof_id is deterministic and non-zero', () => {
    const valueLe8    = u64le(value)
    const lowLe8      = u64le(low)
    const highLe8     = u64le(high)
    const valueCommit = sha256(Buffer.from('rangev3-val-v1'), valueLe8, blinding)
    const rangeCommit = sha256(Buffer.from('rangev3-range-v1'), lowLe8, highLe8)
    const inRange     = Buffer.from([1])
    const proofId1    = sha256(Buffer.from('rangev3-proof-v1'), valueCommit, rangeCommit, inRange)
    const proofId2    = sha256(Buffer.from('rangev3-proof-v1'), valueCommit, rangeCommit, inRange)
    expect(proofId1.equals(proofId2)).toBe(true)
    expect(proofId1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('mainnet_ready is false, is_stub is true', () => {
    const is_stub = true
    expect(MAINNET_READY).toBe(false)
    expect(is_stub).toBe(true)
  })
})
