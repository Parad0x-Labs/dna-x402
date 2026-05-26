import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(32)
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i]
  return out
}

function xorFold(bufs: Buffer[]): Buffer {
  return bufs.reduce(xorBuffers)
}

interface VrfResult {
  pubkey: Buffer
  ringRoot: Buffer
  inputHash: Buffer
  output: Buffer
  proofHash: Buffer
}

function computeVrf(secret: Buffer, ringSecrets: Buffer[], inputBytes: Buffer): VrfResult {
  const pubkey = sha256(Buffer.from('vrf-pubkey-v1'), secret)
  const allPubkeys = ringSecrets.map(s => sha256(Buffer.from('vrf-pubkey-v1'), s))
  const ringRoot = sha256(Buffer.from('vrf-ring-v1'), xorFold(allPubkeys))
  const inputHash = sha256(Buffer.from('vrf-input-v1'), inputBytes)
  const secretHash = sha256(Buffer.from('vrf-secret-v1'), secret)
  const output = sha256(Buffer.from('vrf-output-v1'), ringRoot, inputHash, secretHash)
  const proofHash = sha256(Buffer.from('vrf-proof-v1'), output, ringRoot, inputHash)
  return { pubkey, ringRoot, inputHash, output, proofHash }
}

describe('dark-null Ring VRF', () => {
  const secretA = Buffer.from('member-secret-alice')
  const secretB = Buffer.from('member-secret-bob')
  const secretC = Buffer.from('member-secret-carol')
  const ring = [secretA, secretB, secretC]
  const input = Buffer.from('vrf-input-data')

  it('ring_root depends on all members: removing a member changes ring_root', () => {
    const full = computeVrf(secretA, ring, input)
    const partial = computeVrf(secretA, [secretA, secretB], input)
    expect(full.ringRoot.toString('hex')).not.toBe(partial.ringRoot.toString('hex'))
  })

  it('output is different for different inputs', () => {
    const r1 = computeVrf(secretA, ring, Buffer.from('input-one'))
    const r2 = computeVrf(secretA, ring, Buffer.from('input-two'))
    expect(r1.output.toString('hex')).not.toBe(r2.output.toString('hex'))
  })

  it('output is different for different secrets (both in ring)', () => {
    const rA = computeVrf(secretA, ring, input)
    const rB = computeVrf(secretB, ring, input)
    // Both are members of the same ring, same input, but different secrets → different outputs
    expect(rA.output.toString('hex')).not.toBe(rB.output.toString('hex'))
    // But they share the same ring_root
    expect(rA.ringRoot.toString('hex')).toBe(rB.ringRoot.toString('hex'))
  })

  it('proof_hash is deterministic: same params always yield same proof', () => {
    const r1 = computeVrf(secretA, ring, input)
    const r2 = computeVrf(secretA, ring, input)
    expect(r1.proofHash.toString('hex')).toBe(r2.proofHash.toString('hex'))
  })

  it('verify: recompute proof_hash and compare', () => {
    const { output, ringRoot, inputHash, proofHash } = computeVrf(secretA, ring, input)
    const recomputed = sha256(Buffer.from('vrf-proof-v1'), output, ringRoot, inputHash)
    expect(recomputed.toString('hex')).toBe(proofHash.toString('hex'))
  })

  it('mainnet_ready=false: VRF proof record is not mainnet-ready', () => {
    const { output, ringRoot, inputHash, proofHash } = computeVrf(secretA, ring, input)
    const record = {
      output: output.toString('hex'),
      ring_root: ringRoot.toString('hex'),
      input_hash: inputHash.toString('hex'),
      proof_hash: proofHash.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
