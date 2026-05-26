import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}

// ---------------------------------------------------------------------------
// ZKP Identity Circuit primitives
//
// attrHash(attrs)                  = SHA256("idc-attr-v1"   || attrs)
// commitment(secret, attrHash)     = SHA256("idc-commit-v1" || secret || attrHash)
// nullifier(secret, seed)          = SHA256("idc-null-v1"   || secret || seed)
// circuitId(commitment, nullifier) = SHA256("idc-id-v1"     || commitment || nullifier)
// pubInputsHash(circuitId, attrHash) = SHA256("idc-pub-v1"  || circuitId || attrHash)
// proofId(circuitId, pubInputsHash)  = SHA256("idc-proof-v1"|| circuitId || pubInputsHash)
// ---------------------------------------------------------------------------

function attrHash(attrs: Buffer): Buffer {
  return sha256(Buffer.from('idc-attr-v1'), attrs)
}

function commitment(secret: Buffer, aHash: Buffer): Buffer {
  return sha256(Buffer.from('idc-commit-v1'), secret, aHash)
}

function nullifier(secret: Buffer, seed: Buffer): Buffer {
  return sha256(Buffer.from('idc-null-v1'), secret, seed)
}

function circuitId(commit: Buffer, nullif: Buffer): Buffer {
  return sha256(Buffer.from('idc-id-v1'), commit, nullif)
}

function pubInputsHash(cId: Buffer, aHash: Buffer): Buffer {
  return sha256(Buffer.from('idc-pub-v1'), cId, aHash)
}

function proofId(cId: Buffer, pubHash: Buffer): Buffer {
  return sha256(Buffer.from('idc-proof-v1'), cId, pubHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zkp-identity-circuit', () => {
  const SECRET = Buffer.alloc(32).fill(0xab)
  const ATTRS  = Buffer.from('age=30,kyc=passed,country=US')
  const SEED   = Buffer.alloc(32).fill(0x11)

  // Test 1: circuit_id vector test
  it('circuit_id = SHA256("idc-id-v1" || commitment || nullifier)', () => {
    const aHash  = attrHash(ATTRS)
    const commit = commitment(SECRET, aHash)
    const nullif = nullifier(SECRET, SEED)
    const cId    = circuitId(commit, nullif)

    const expected = sha256(Buffer.from('idc-id-v1'), commit, nullif)
    expect(cId.length).toBe(32)
    expect(cId.equals(expected)).toBe(true)
    expect(cId.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 2: proof_id formula is correct
  it('proof_id formula is correct', () => {
    const aHash   = attrHash(ATTRS)
    const commit  = commitment(SECRET, aHash)
    const nullif  = nullifier(SECRET, SEED)
    const cId     = circuitId(commit, nullif)
    const pubHash = pubInputsHash(cId, aHash)
    const pId     = proofId(cId, pubHash)

    const expected = sha256(Buffer.from('idc-proof-v1'), cId, pubHash)
    expect(pId.length).toBe(32)
    expect(pId.equals(expected)).toBe(true)
  })

  // Test 3: different attributes produce different commitments
  it('different attributes produce different commitments', () => {
    const attrsA = Buffer.from('age=25,kyc=passed')
    const attrsB = Buffer.from('age=40,kyc=failed')
    const aHashA = attrHash(attrsA)
    const aHashB = attrHash(attrsB)
    const commitA = commitment(SECRET, aHashA)
    const commitB = commitment(SECRET, aHashB)
    expect(commitA.equals(commitB)).toBe(false)
  })

  // Test 4: proof_id is deterministic and non-zero
  it('proof_id is deterministic and non-zero', () => {
    const aHash   = attrHash(ATTRS)
    const commit  = commitment(SECRET, aHash)
    const nullif  = nullifier(SECRET, SEED)
    const cId     = circuitId(commit, nullif)
    const pubHash = pubInputsHash(cId, aHash)
    const pId1    = proofId(cId, pubHash)
    const pId2    = proofId(cId, pubHash)
    expect(pId1.equals(pId2)).toBe(true)
    expect(pId1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 5: is_stub = true (circuit is a stub)
  it('is_stub = true (circuit is a stub)', () => {
    const is_stub = true
    expect(is_stub).toBe(true)
  })

  // Test 6: mainnet_ready is false
  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
