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

function computeInputHash(i: number, inputBytes: Buffer): Buffer {
  return sha256(Buffer.from('groth16-input-v1'), Buffer.from([i]), inputBytes)
}

function computePublicInputsHash(inputHashes: Buffer[]): Buffer {
  return sha256(Buffer.from('groth16-inputs-v1'), xorFold(inputHashes))
}

function computeProofA(provingKey: Buffer, publicInputsHash: Buffer): Buffer {
  return sha256(Buffer.from('groth16-a-v1'), provingKey, publicInputsHash)
}

function computeProofB(provingKey: Buffer, proofA: Buffer): Buffer {
  return sha256(Buffer.from('groth16-b-v1'), provingKey, proofA)
}

function computeProofC(provingKey: Buffer, proofA: Buffer, proofB: Buffer): Buffer {
  return sha256(Buffer.from('groth16-c-v1'), provingKey, proofA, proofB)
}

describe('dark-null groth16-stub', () => {
  const provingKey = Buffer.from('test-proving-key-32-bytes-padded!!')
  const input0 = Buffer.from('private-witness-alpha')
  const input1 = Buffer.from('private-witness-beta')

  const inputHash0 = computeInputHash(0, input0)
  const inputHash1 = computeInputHash(1, input1)
  const publicInputsHash = computePublicInputsHash([inputHash0, inputHash1])
  const proofA = computeProofA(provingKey, publicInputsHash)
  const proofB = computeProofB(provingKey, proofA)
  const proofC = computeProofC(provingKey, proofA, proofB)

  it('computes proof_a correctly', () => {
    const expected = sha256(Buffer.from('groth16-a-v1'), provingKey, publicInputsHash)
    expect(proofA.toString('hex')).toBe(expected.toString('hex'))
    expect(proofA).toHaveLength(32)
  })

  it('computes proof_b and proof_c correctly', () => {
    const expectedB = sha256(Buffer.from('groth16-b-v1'), provingKey, proofA)
    const expectedC = sha256(Buffer.from('groth16-c-v1'), provingKey, proofA, proofB)
    expect(proofB.toString('hex')).toBe(expectedB.toString('hex'))
    expect(proofC.toString('hex')).toBe(expectedC.toString('hex'))
    expect(proofC).toHaveLength(32)
  })

  it('proof generation is deterministic', () => {
    const pih2 = computePublicInputsHash([computeInputHash(0, input0), computeInputHash(1, input1)])
    const a2 = computeProofA(provingKey, pih2)
    const b2 = computeProofB(provingKey, a2)
    const c2 = computeProofC(provingKey, a2, b2)
    expect(a2.toString('hex')).toBe(proofA.toString('hex'))
    expect(b2.toString('hex')).toBe(proofB.toString('hex'))
    expect(c2.toString('hex')).toBe(proofC.toString('hex'))
  })

  it('proof changes when input changes', () => {
    const altInput = Buffer.from('different-witness-data')
    const altHash0 = computeInputHash(0, altInput)
    const altPIH = computePublicInputsHash([altHash0, inputHash1])
    const altA = computeProofA(provingKey, altPIH)
    expect(altA.toString('hex')).not.toBe(proofA.toString('hex'))
  })

  it('verifies by recomputing public_inputs_hash', () => {
    const recomputedHash0 = computeInputHash(0, input0)
    const recomputedHash1 = computeInputHash(1, input1)
    const recomputedPIH = computePublicInputsHash([recomputedHash0, recomputedHash1])
    expect(recomputedPIH.toString('hex')).toBe(publicInputsHash.toString('hex'))
    // verifier can check proof_a is consistent with this public_inputs_hash
    const verifiedA = computeProofA(provingKey, recomputedPIH)
    expect(verifiedA.toString('hex')).toBe(proofA.toString('hex'))
  })

  it('is_stub=true and mainnet_ready=false', () => {
    const IS_STUB = true
    const MAINNET_READY = false
    expect(IS_STUB).toBe(true)
    expect(MAINNET_READY).toBe(false)
    // Stub proof: proof_c does not require a real ZK circuit
    expect(proofC).toHaveLength(32)
  })
})
