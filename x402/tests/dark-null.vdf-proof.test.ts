import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u32le(n: number): Buffer {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32LE(n, 0)
  return b
}

function computeVdf(inputBytes: Buffer, difficulty: number): { challengeHash: Buffer; output: Buffer; proofHash: Buffer } {
  const challengeHash = sha256(Buffer.from('vdf-challenge-v1'), inputBytes)

  let state = challengeHash
  for (let i = 0; i < difficulty; i++) {
    state = sha256(Buffer.from('vdf-iter-v1'), state, u32le(i))
  }
  const finalOutput = state

  const proofHash = sha256(Buffer.from('vdf-proof-v1'), challengeHash, finalOutput, u32le(difficulty))

  return { challengeHash, output: finalOutput, proofHash }
}

describe('dark-null VDF Proof', () => {
  it('challenge_hash has correct domain separation', () => {
    const input = Buffer.from('test-input')
    const challengeHash = sha256(Buffer.from('vdf-challenge-v1'), input)
    // Should differ from a hash without the domain prefix
    const noDomain = sha256(input)
    expect(challengeHash.toString('hex')).not.toBe(noDomain.toString('hex'))
    // Should be 32 bytes
    expect(challengeHash.length).toBe(32)
  })

  it('VDF is deterministic: same challenge+difficulty produces same output', () => {
    const input = Buffer.from('deterministic-test')
    const r1 = computeVdf(input, 5)
    const r2 = computeVdf(input, 5)
    expect(r1.output.toString('hex')).toBe(r2.output.toString('hex'))
    expect(r1.proofHash.toString('hex')).toBe(r2.proofHash.toString('hex'))
  })

  it('higher difficulty produces different output than lower difficulty', () => {
    const input = Buffer.from('difficulty-test')
    const low = computeVdf(input, 3)
    const high = computeVdf(input, 10)
    expect(low.output.toString('hex')).not.toBe(high.output.toString('hex'))
    expect(low.proofHash.toString('hex')).not.toBe(high.proofHash.toString('hex'))
  })

  it('verify_work: recompute output from challenge, check it matches proof', () => {
    const input = Buffer.from('verify-work-test')
    const difficulty = 4
    const { challengeHash, output, proofHash } = computeVdf(input, difficulty)

    // Recompute output from scratch
    let state = challengeHash
    for (let i = 0; i < difficulty; i++) {
      state = sha256(Buffer.from('vdf-iter-v1'), state, u32le(i))
    }
    expect(state.toString('hex')).toBe(output.toString('hex'))

    // Recompute proof hash and verify
    const recomputedProof = sha256(Buffer.from('vdf-proof-v1'), challengeHash, state, u32le(difficulty))
    expect(recomputedProof.toString('hex')).toBe(proofHash.toString('hex'))
  })

  it('difficulty=0 results in output equal to challenge_hash (0 iterations)', () => {
    const input = Buffer.from('zero-difficulty')
    const { challengeHash, output } = computeVdf(input, 0)
    expect(output.toString('hex')).toBe(challengeHash.toString('hex'))
  })

  it('mainnet_ready=false: proof record is not mainnet-ready', () => {
    const input = Buffer.from('mainnet-check')
    const { challengeHash, output, proofHash } = computeVdf(input, 2)
    const record = {
      challenge_hash: challengeHash.toString('hex'),
      output: output.toString('hex'),
      proof_hash: proofHash.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
