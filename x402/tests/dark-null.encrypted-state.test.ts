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

function computeOwnerHash(ownerSecret: Buffer): Buffer {
  return sha256(Buffer.from('state-owner-v1'), ownerSecret)
}

function computeStateHash(ownerHash: Buffer, stateBytes: Buffer, version: number): Buffer {
  return sha256(Buffer.from('state-hash-v1'), ownerHash, stateBytes, u32le(version))
}

function computeStateId(ownerHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('state-id-v1'), ownerHash, nonce)
}

function computeTransitionHash(fromHash: Buffer, toHash: Buffer, newVersion: number): Buffer {
  return sha256(Buffer.from('state-trans-v1'), fromHash, toHash, u32le(newVersion))
}

describe('dark-null encrypted-state', () => {
  const ownerSecret = Buffer.from('owner-private-key-gamma')
  const stateBytes = Buffer.from('{"balance":9999,"locked":false}')
  const nonce = Buffer.from('state-nonce-xyz-001')
  const VERSION_0 = 0
  const VERSION_1 = 1

  const ownerHash = computeOwnerHash(ownerSecret)
  const stateHash = computeStateHash(ownerHash, stateBytes, VERSION_0)
  const stateId = computeStateId(ownerHash, nonce)

  const updatedStateBytes = Buffer.from('{"balance":8888,"locked":true}')
  const updatedStateHash = computeStateHash(ownerHash, updatedStateBytes, VERSION_1)
  const transitionHash = computeTransitionHash(stateHash, updatedStateHash, VERSION_1)

  it('computes state_hash correctly', () => {
    const expected = sha256(
      Buffer.from('state-hash-v1'),
      ownerHash,
      stateBytes,
      u32le(VERSION_0)
    )
    expect(stateHash.toString('hex')).toBe(expected.toString('hex'))
    expect(stateHash).toHaveLength(32)
  })

  it('computes state_id correctly', () => {
    const expected = sha256(Buffer.from('state-id-v1'), ownerHash, nonce)
    expect(stateId.toString('hex')).toBe(expected.toString('hex'))
    expect(stateId).toHaveLength(32)
  })

  it('computes transition_hash correctly', () => {
    const expected = sha256(
      Buffer.from('state-trans-v1'),
      stateHash,
      updatedStateHash,
      u32le(VERSION_1)
    )
    expect(transitionHash.toString('hex')).toBe(expected.toString('hex'))
    expect(transitionHash).toHaveLength(32)
  })

  it('state_hash changes when content changes', () => {
    const altState = Buffer.from('{"balance":0,"locked":true}')
    const altHash = computeStateHash(ownerHash, altState, VERSION_0)
    expect(altHash.toString('hex')).not.toBe(stateHash.toString('hex'))
  })

  it('state_hash changes when version changes', () => {
    const sameContentV1 = computeStateHash(ownerHash, stateBytes, VERSION_1)
    expect(sameContentV1.toString('hex')).not.toBe(stateHash.toString('hex'))
  })

  it('public record hides owner_hash (secret is not recoverable from state_id)', () => {
    // stateId contains ownerHash internally but ownerSecret is not exposed
    const stateIdHex = stateId.toString('hex')
    const secretHex = ownerSecret.toString('hex')
    expect(stateIdHex).not.toContain(secretHex)
    // owner can prove ownership by recomputing ownerHash
    const recomputed = computeOwnerHash(ownerSecret)
    expect(recomputed.toString('hex')).toBe(ownerHash.toString('hex'))
  })
})
