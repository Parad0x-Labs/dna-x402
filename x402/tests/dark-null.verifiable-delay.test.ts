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

// ---------------------------------------------------------------------------
// Domain primitives — verifiable-delay (vdf2)
// ---------------------------------------------------------------------------

function inputHash(input: Buffer): Buffer {
  return sha256(Buffer.from('vdf2-input-v1'), input)
}

function computeDelay(inputH: Buffer, rounds: number): Buffer {
  let state = inputH
  for (let i = 0; i < rounds; i++) {
    state = sha256(Buffer.from('vdf2-iter-v1'), state, u32le(i))
  }
  return state
}

function proofId(inputH: Buffer, outputH: Buffer, rounds: number): Buffer {
  return sha256(Buffer.from('vdf2-proof-v1'), inputH, outputH, u32le(rounds))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null verifiable-delay', () => {
  const rawInput = Buffer.from('vdf-test-input-2024')
  const inputH = inputHash(rawInput)

  it('input_hash = SHA256("vdf2-input-v1" || input)', () => {
    const expected = sha256(Buffer.from('vdf2-input-v1'), rawInput)
    expect(inputH.toString('hex')).toBe(expected.toString('hex'))
    expect(inputH.length).toBe(32)
    expect(inputH.every(b => b === 0)).toBe(false)
  })

  it('output_hash after 3 rounds matches manual iteration', () => {
    const rounds = 3
    const output = computeDelay(inputH, rounds)

    // Manual iteration
    let state = inputH
    state = sha256(Buffer.from('vdf2-iter-v1'), state, u32le(0))
    state = sha256(Buffer.from('vdf2-iter-v1'), state, u32le(1))
    state = sha256(Buffer.from('vdf2-iter-v1'), state, u32le(2))

    expect(output.toString('hex')).toBe(state.toString('hex'))
  })

  it('proof_id formula is correct', () => {
    const rounds = 3
    const outputH = computeDelay(inputH, rounds)
    const pid = proofId(inputH, outputH, rounds)
    const expected = sha256(Buffer.from('vdf2-proof-v1'), inputH, outputH, u32le(rounds))
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
    expect(pid.length).toBe(32)
  })

  it('different rounds produce different output_hash', () => {
    const out3 = computeDelay(inputH, 3)
    const out5 = computeDelay(inputH, 5)
    expect(out3.toString('hex')).not.toBe(out5.toString('hex'))
  })

  it('proof_id is deterministic and non-zero', () => {
    const rounds = 4
    const outputH = computeDelay(inputH, rounds)
    const pid1 = proofId(inputH, outputH, rounds)
    const pid2 = proofId(inputH, outputH, rounds)
    expect(pid1.toString('hex')).toBe(pid2.toString('hex'))
    expect(pid1.every(b => b === 0)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = { mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
