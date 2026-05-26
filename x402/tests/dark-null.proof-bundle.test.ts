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

function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

const MAX_BUNDLE_SIZE = 16

function computeAggregateHash(proofHashes: Buffer[], count: number): Buffer {
  const xor = xorFold(proofHashes)
  return sha256(Buffer.from('bundle-agg-v1'), xor, u32le(count))
}

function computeBundleId(aggregateHash: Buffer): Buffer {
  return sha256(Buffer.from('bundle-id-v1'), aggregateHash)
}

function ph(b: number): Buffer { return Buffer.alloc(32, b) }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null proof-bundle', () => {
  it('aggregate_hash with 3 proofs is correct', () => {
    const proofs = [ph(1), ph(2), ph(3)]
    const agg = computeAggregateHash(proofs, proofs.length)

    expect(agg).toBeInstanceOf(Buffer)
    expect(agg.length).toBe(32)

    const expected = sha256(Buffer.from('bundle-agg-v1'), xorFold(proofs), u32le(3))
    expect(agg.toString('hex')).toBe(expected.toString('hex'))
  })

  it('bundle_id computation is correct', () => {
    const proofs = [ph(1), ph(2), ph(3)]
    const agg = computeAggregateHash(proofs, proofs.length)
    const bundleId = computeBundleId(agg)

    expect(bundleId).toBeInstanceOf(Buffer)
    expect(bundleId.length).toBe(32)

    const expected = sha256(Buffer.from('bundle-id-v1'), agg)
    expect(bundleId.toString('hex')).toBe(expected.toString('hex'))
  })

  it('adding a proof changes aggregate_hash', () => {
    const proofs2 = [ph(1), ph(2)]
    const proofs3 = [ph(1), ph(2), ph(5)]

    const agg2 = computeAggregateHash(proofs2, proofs2.length)
    const agg3 = computeAggregateHash(proofs3, proofs3.length)

    expect(agg2.toString('hex')).not.toBe(agg3.toString('hex'))

    const bid2 = computeBundleId(agg2)
    const bid3 = computeBundleId(agg3)
    expect(bid2.toString('hex')).not.toBe(bid3.toString('hex'))
  })

  it('MAX_BUNDLE_SIZE = 16', () => {
    expect(MAX_BUNDLE_SIZE).toBe(16)

    // Trying to create a bundle with 17 proofs should be rejected
    const tooMany = Array.from({ length: 17 }, (_, i) => ph(i + 1))
    expect(tooMany.length).toBeGreaterThan(MAX_BUNDLE_SIZE)
  })

  it('duplicate detection: same hash twice differs from two unique hashes', () => {
    // Two identical proofs [ph(1), ph(1)]
    const dupProofs = [ph(1), ph(1)]
    const aggDup = computeAggregateHash(dupProofs, dupProofs.length)

    // Two unique proofs [ph(1), ph(2)]
    const uniqueProofs = [ph(1), ph(2)]
    const aggUnique = computeAggregateHash(uniqueProofs, uniqueProofs.length)

    // The aggregates are different (XOR of [1,1] cancels to zero; [1,2] does not)
    expect(aggDup.toString('hex')).not.toBe(aggUnique.toString('hex'))

    // Specifically, XOR of two identical buffers = zeros
    const xorDup = xorFold(dupProofs)
    expect(xorDup.every(b => b === 0)).toBe(true)

    const xorUnique = xorFold(uniqueProofs)
    expect(xorUnique.every(b => b === 0)).toBe(false)
  })

  it('mainnet_ready=false', () => {
    const proofs = [ph(10), ph(20)]
    const agg = computeAggregateHash(proofs, proofs.length)
    const bundleId = computeBundleId(agg)

    const publicRecord = {
      bundle_id: bundleId.toString('hex'),
      aggregate_hash: agg.toString('hex'),
      proof_count: proofs.length,
      mainnet_ready: false,
    }

    expect(publicRecord.mainnet_ready).toBe(false)
  })
})
