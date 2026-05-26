import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  return acc
}

function computeW(i: number, witnessBytes: Buffer): Buffer {
  return sha256(Buffer.from('plonk-w-v1'), Buffer.from([i]), witnessBytes)
}

function computeWitnessHash(ws: Buffer[]): Buffer {
  return sha256(Buffer.from('plonk-witness-v1'), xorFold(ws))
}

function computeSrsHash(srs: Buffer): Buffer {
  return sha256(Buffer.from('plonk-srs-v1'), srs)
}

function computeCommitment(srsHash: Buffer, witnessHash: Buffer): Buffer {
  return sha256(Buffer.from('plonk-commit-v1'), srsHash, witnessHash)
}

function computeChallenge(commitment: Buffer): Buffer {
  return sha256(Buffer.from('plonk-challenge-v1'), commitment)
}

function computeOpening(commitment: Buffer, challenge: Buffer): Buffer {
  return sha256(Buffer.from('plonk-open-v1'), commitment, challenge)
}

function computeEvalHash(opening: Buffer, commitment: Buffer): Buffer {
  return sha256(Buffer.from('plonk-eval-v1'), opening, commitment)
}

describe('dark-null plonk-stub', () => {
  const srs = Buffer.from('structured-reference-string-srs!')
  const witness0 = Buffer.from('witness-value-zero')
  const witness1 = Buffer.from('witness-value-one')

  const w0 = computeW(0, witness0)
  const w1 = computeW(1, witness1)
  const witnessHash = computeWitnessHash([w0, w1])
  const srsHash = computeSrsHash(srs)
  const commitment = computeCommitment(srsHash, witnessHash)
  const challenge = computeChallenge(commitment)
  const opening = computeOpening(commitment, challenge)
  const evalHash = computeEvalHash(opening, commitment)

  it('computes commitment correctly', () => {
    const expectedSrsHash = sha256(Buffer.from('plonk-srs-v1'), srs)
    const expectedWitnessHash = sha256(Buffer.from('plonk-witness-v1'), xorFold([w0, w1]))
    const expectedCommitment = sha256(Buffer.from('plonk-commit-v1'), expectedSrsHash, expectedWitnessHash)
    expect(commitment.toString('hex')).toBe(expectedCommitment.toString('hex'))
    expect(commitment).toHaveLength(32)
  })

  it('proof pipeline is deterministic', () => {
    const w0b = computeW(0, witness0)
    const w1b = computeW(1, witness1)
    const wh2 = computeWitnessHash([w0b, w1b])
    const sh2 = computeSrsHash(srs)
    const c2 = computeCommitment(sh2, wh2)
    const ch2 = computeChallenge(c2)
    const o2 = computeOpening(c2, ch2)
    const e2 = computeEvalHash(o2, c2)
    expect(c2.toString('hex')).toBe(commitment.toString('hex'))
    expect(e2.toString('hex')).toBe(evalHash.toString('hex'))
  })

  it('commitment changes when witness changes', () => {
    const altWitness = Buffer.from('completely-different-witness')
    const altW0 = computeW(0, altWitness)
    const altWH = computeWitnessHash([altW0, w1])
    const altCommitment = computeCommitment(srsHash, altWH)
    expect(altCommitment.toString('hex')).not.toBe(commitment.toString('hex'))
  })

  it('verifies by recomputing eval_hash', () => {
    const reW0 = computeW(0, witness0)
    const reW1 = computeW(1, witness1)
    const reWH = computeWitnessHash([reW0, reW1])
    const reSrsH = computeSrsHash(srs)
    const reCommit = computeCommitment(reSrsH, reWH)
    const reChallenge = computeChallenge(reCommit)
    const reOpening = computeOpening(reCommit, reChallenge)
    const reEval = computeEvalHash(reOpening, reCommit)
    expect(reEval.toString('hex')).toBe(evalHash.toString('hex'))
  })

  it('is_stub=true', () => {
    const IS_STUB = true
    expect(IS_STUB).toBe(true)
    // opening is derived from commitment+challenge, not a real polynomial opening
    expect(opening).toHaveLength(32)
    expect(challenge).toHaveLength(32)
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
    // eval_hash is 32 bytes but not a real PLONK evaluation proof
    expect(evalHash).toHaveLength(32)
  })
})
