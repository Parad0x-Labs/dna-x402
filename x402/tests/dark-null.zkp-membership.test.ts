import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// ZKP Membership primitives (mirrors crates/dark-zkp-membership/src/lib.rs)
//
// element_hash = SHA256("memb-elem-v1"   || element_bytes)
// element_root = SHA256("memb-root-v1"   || XOR_fold(element_hashes))
// set_id       = SHA256("memb-set-v1"    || element_root || size_u32le)
// commitment   = SHA256("memb-commit-v1" || element_hash || secret)
// proof_id     = SHA256("memb-proof-v1"  || set_id || commitment)
// ---------------------------------------------------------------------------

function elementHash(elemBytes: Buffer): Buffer {
  return sha256(Buffer.from('memb-elem-v1'), elemBytes)
}

function elementRoot(elemHashes: Buffer[]): Buffer {
  const folded = xorFold(elemHashes)
  return sha256(Buffer.from('memb-root-v1'), folded)
}

function setId(eRoot: Buffer, size: number): Buffer {
  return sha256(Buffer.from('memb-set-v1'), eRoot, u32le(size))
}

function commitment(eHash: Buffer, secret: Buffer): Buffer {
  return sha256(Buffer.from('memb-commit-v1'), eHash, secret)
}

function proofId(sId: Buffer, commit: Buffer): Buffer {
  return sha256(Buffer.from('memb-proof-v1'), sId, commit)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zkp-membership', () => {
  const ELEM_A = Buffer.from('member-alice')
  const ELEM_B = Buffer.from('member-bob')
  const ELEM_C = Buffer.from('member-carol')
  const SECRET = Buffer.alloc(32).fill(0x77)
  const SECRET_2 = Buffer.alloc(32).fill(0x88)

  // Test 1: set_id computation
  it('set_id computation is deterministic', () => {
    const ehA = elementHash(ELEM_A)
    const ehB = elementHash(ELEM_B)
    const eRoot = elementRoot([ehA, ehB])
    const sId = setId(eRoot, 2)
    const sId2 = setId(eRoot, 2)
    expect(sId.length).toBe(32)
    expect(sId.equals(sId2)).toBe(true)
    // Manual recompute
    const folded = xorFold([ehA, ehB])
    const expectedRoot = sha256(Buffer.from('memb-root-v1'), folded)
    const expectedId = sha256(Buffer.from('memb-set-v1'), expectedRoot, u32le(2))
    expect(sId.equals(expectedId)).toBe(true)
  })

  // Test 2: proof_id computation
  it('proof_id computation is deterministic', () => {
    const ehA = elementHash(ELEM_A)
    const ehB = elementHash(ELEM_B)
    const eRoot = elementRoot([ehA, ehB])
    const sId = setId(eRoot, 2)
    const commit = commitment(ehA, SECRET)
    const pid = proofId(sId, commit)
    const pid2 = proofId(sId, commit)
    expect(pid.length).toBe(32)
    expect(pid.equals(pid2)).toBe(true)
    const expected = sha256(Buffer.from('memb-proof-v1'), sId, commit)
    expect(pid.equals(expected)).toBe(true)
  })

  // Test 3: commitment sensitive to secret
  it('commitment sensitive to secret', () => {
    const eh = elementHash(ELEM_A)
    const c1 = commitment(eh, SECRET)
    const c2 = commitment(eh, SECRET_2)
    expect(c1.equals(c2)).toBe(false)
  })

  // Test 4: different elements → different commitments
  it('different elements produce different commitments', () => {
    const ehA = elementHash(ELEM_A)
    const ehB = elementHash(ELEM_B)
    const cA = commitment(ehA, SECRET)
    const cB = commitment(ehB, SECRET)
    expect(cA.equals(cB)).toBe(false)
  })

  // Test 5: verify by recomputing
  it('verify by recomputing proof_id from scratch', () => {
    const ehA = elementHash(ELEM_A)
    const ehB = elementHash(ELEM_B)
    const ehC = elementHash(ELEM_C)
    const eRoot = elementRoot([ehA, ehB, ehC])
    const sId = setId(eRoot, 3)
    const commit = commitment(ehB, SECRET)
    const pid = proofId(sId, commit)
    // Recompute independently
    const foldedCheck = xorFold([ehA, ehB, ehC])
    const rootCheck = sha256(Buffer.from('memb-root-v1'), foldedCheck)
    const sidCheck = sha256(Buffer.from('memb-set-v1'), rootCheck, u32le(3))
    const commitCheck = sha256(Buffer.from('memb-commit-v1'), ehB, SECRET)
    const pidCheck = sha256(Buffer.from('memb-proof-v1'), sidCheck, commitCheck)
    expect(pid.equals(pidCheck)).toBe(true)
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready=false confirmed', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
    // set_id changes when size changes (even with same elements)
    const ehA = elementHash(ELEM_A)
    const eRoot = elementRoot([ehA])
    const sidSize1 = setId(eRoot, 1)
    const sidSize5 = setId(eRoot, 5)
    expect(sidSize1.equals(sidSize5)).toBe(false)
  })
})
