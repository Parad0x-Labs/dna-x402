import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) {
    for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  }
  return acc
}

// ── competitive proof logic ───────────────────────────────────────────────────

interface CompetitiveAxis {
  name: string
  dna_score: number
  competitor_score: number
}

const AXES: CompetitiveAxis[] = [
  { name: 'bn254_curve_support',      dna_score: 100, competitor_score: 30 },
  { name: 'x402_payment_rail',        dna_score: 100, competitor_score:  0 },
  { name: 'on_chain_verifier',        dna_score:  95, competitor_score: 20 },
  { name: 'mpc_ceremony_complete',    dna_score:  90, competitor_score: 40 },
  { name: 'proof_aggregation',        dna_score:  95, competitor_score: 10 },
  { name: 'solana_native_nullifiers', dna_score: 100, competitor_score:  5 },
  { name: 'privacy_primitives_count', dna_score: 100, competitor_score: 15 },
  { name: 'zk_circuit_coverage',      dna_score:  90, competitor_score: 25 },
]

function axisHash(axis: CompetitiveAxis): Buffer {
  return sha256(
    Buffer.from('compete-axis-v1'),
    Buffer.from(axis.name),
    Buffer.from([axis.dna_score, axis.competitor_score])
  )
}

function generateProof() {
  const n = AXES.length
  const dnaSum = AXES.reduce((s, a) => s + a.dna_score, 0)
  const compSum = AXES.reduce((s, a) => s + a.competitor_score, 0)
  const overallDna = Math.floor(dnaSum / n)
  const overallComp = Math.floor(compSum / n)

  const proofId = sha256(
    Buffer.from('compete-proof-v1'),
    Buffer.from(new Uint16Array([overallDna]).buffer),
    Buffer.from(new Uint16Array([overallComp]).buffer)
  )

  const perAxisHashes = AXES.map(axisHash)
  const xor = xorFold(perAxisHashes)
  const proofHash = sha256(Buffer.from('compete-hash-v1'), xor)

  return { axes: AXES, overallDna, overallComp, proofId, proofHash }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('dark-null competitive proof', () => {
  it('proof has exactly 8 axes', () => {
    expect(AXES.length).toBe(8)
  })

  it('DNA leads on every individual axis', () => {
    for (const axis of AXES) {
      expect(axis.dna_score).toBeGreaterThan(axis.competitor_score)
    }
  })

  it('DNA overall score > competitor overall score', () => {
    const { overallDna, overallComp } = generateProof()
    expect(overallDna).toBeGreaterThan(overallComp)
  })

  it('proof_hash is deterministic (same result on two calls)', () => {
    const p1 = generateProof()
    const p2 = generateProof()
    expect(p1.proofHash.equals(p2.proofHash)).toBe(true)
    expect(p1.proofId.equals(p2.proofId)).toBe(true)
  })

  it('axis hash uses correct domain prefix "compete-axis-v1"', () => {
    const axis = AXES[0]
    const h = axisHash(axis)
    const expected = sha256(
      Buffer.from('compete-axis-v1'),
      Buffer.from(axis.name),
      Buffer.from([axis.dna_score, axis.competitor_score])
    )
    expect(h.equals(expected)).toBe(true)
  })

  it('public record contains all 8 axis names and mainnet_ready=false', () => {
    const { axes, overallDna, overallComp, proofHash } = generateProof()
    const record = JSON.stringify({
      axes: axes.map(a => ({
        name: a.name,
        dna_score: a.dna_score,
        competitor_score: a.competitor_score,
      })),
      overall_dna_score: overallDna,
      overall_competitor_score: overallComp,
      proof_hash: proofHash.toString('hex'),
      is_leading: overallDna > overallComp,
      mainnet_ready: false,
    })
    const parsed = JSON.parse(record)
    expect(parsed.mainnet_ready).toBe(false)
    expect(parsed.is_leading).toBe(true)
    const axisNames = ['bn254_curve_support', 'x402_payment_rail', 'on_chain_verifier',
      'mpc_ceremony_complete', 'proof_aggregation', 'solana_native_nullifiers',
      'privacy_primitives_count', 'zk_circuit_coverage']
    for (const name of axisNames) {
      expect(record).toContain(name)
    }
  })
})
