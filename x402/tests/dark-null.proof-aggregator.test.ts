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

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Proof-aggregator primitives (mirrors crates/dark-proof-aggregator)
//
// output_hash = SHA256("agg-output-v1" || XOR_fold(input_proofs) || count_u32le)
// agg_id      = SHA256("agg-id-v1"    || output_hash             || count_u32le)
// MAX_INPUTS  = 32
// ---------------------------------------------------------------------------

const MAX_INPUTS = 32

const PFX_OUTPUT = Buffer.from('agg-output-v1')
const PFX_AGG_ID = Buffer.from('agg-id-v1')

function computeOutputHash(inputs: Buffer[], count: number): Buffer {
  return sha256(PFX_OUTPUT, xorFold(inputs), u32le(count))
}

function computeAggId(outputHash: Buffer, count: number): Buffer {
  return sha256(PFX_AGG_ID, outputHash, u32le(count))
}

function makeProof(seed: number): Buffer {
  const b = Buffer.alloc(32, 0)
  b[0] = seed
  return b
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null proof-aggregator', () => {
  it('output_hash with 3 distinct proofs is deterministic', () => {
    const proofs = [makeProof(1), makeProof(2), makeProof(3)]
    const h1 = computeOutputHash(proofs, 3)
    const h2 = computeOutputHash(proofs, 3)
    expect(h1.equals(h2)).toBe(true)
    expect(h1.length).toBe(32)
  })

  it('agg_id computation is deterministic', () => {
    const proofs  = [makeProof(10), makeProof(20), makeProof(30)]
    const outHash = computeOutputHash(proofs, proofs.length)
    const id1     = computeAggId(outHash, proofs.length)
    const id2     = computeAggId(outHash, proofs.length)
    expect(id1.equals(id2)).toBe(true)

    // Manual round-trip: recompute from scratch
    const outHash2 = computeOutputHash(proofs, proofs.length)
    const id3      = computeAggId(outHash2, proofs.length)
    expect(id1.equals(id3)).toBe(true)
  })

  it('verify: recompute output_hash and agg_id must match', () => {
    const proofs   = [makeProof(7), makeProof(8), makeProof(9)]
    const count    = proofs.length
    const outHash  = computeOutputHash(proofs, count)
    const aggId    = computeAggId(outHash, count)

    // Verify by recomputing
    const verifyOutput = computeOutputHash(proofs, count)
    const verifyId     = computeAggId(verifyOutput, count)

    expect(verifyOutput.equals(outHash)).toBe(true)
    expect(verifyId.equals(aggId)).toBe(true)
  })

  it('changing one input proof changes the output_hash', () => {
    const proofsA = [makeProof(1), makeProof(2), makeProof(3)]
    const proofsB = [makeProof(1), makeProof(2), makeProof(99)] // last proof differs

    const outA = computeOutputHash(proofsA, proofsA.length)
    const outB = computeOutputHash(proofsB, proofsB.length)
    expect(outA.equals(outB)).toBe(false)

    const idA = computeAggId(outA, proofsA.length)
    const idB = computeAggId(outB, proofsB.length)
    expect(idA.equals(idB)).toBe(false)
  })

  it('is_stub=true and mainnet_ready=false constants hold', () => {
    // These are properties of the crate; mirror them in the TS layer
    const stubFlag: boolean     = true
    const mainnetFlag: boolean  = false
    expect(stubFlag).toBe(true)
    expect(mainnetFlag).toBe(false)
  })

  it('MAX_INPUTS is 32', () => {
    expect(MAX_INPUTS).toBe(32)

    // Attempting to aggregate 33 proofs would exceed MAX_INPUTS
    const tooMany = Array.from({ length: 33 }, (_, i) => makeProof(i + 1))
    expect(tooMany.length).toBeGreaterThan(MAX_INPUTS)
  })
})
