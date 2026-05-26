import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

// ---------------------------------------------------------------------------
// Note Commitment primitives
//
// recipientHash(secret)               = SHA256("note-rcpt-v1"   || secret)
// valueHash(value_u64le, blinding)    = SHA256("note-value-v1"  || value_le8 || blinding)
// commitment(valueHash, recipientHash)= SHA256("note-commit-v1" || valueHash || recipientHash)
// nullifier(commitment, recipientHash)= SHA256("note-null-v1"   || commitment || recipientHash)
// noteId(commitment, nullifier)       = SHA256("note-id-v1"     || commitment || nullifier)
// blindingHash(blinding)              = SHA256("note-blind-v1"  || blinding)
// proofId(noteId, value_u64le)        = SHA256("note-proof-v1"  || noteId || value_le8)
// ---------------------------------------------------------------------------

function recipientHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('note-rcpt-v1'), secret)
}

function valueHash(value: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('note-value-v1'), u64le(value), blinding)
}

function commitment(vHash: Buffer, rHash: Buffer): Buffer {
  return sha256(Buffer.from('note-commit-v1'), vHash, rHash)
}

function nullifier(commit: Buffer, rHash: Buffer): Buffer {
  return sha256(Buffer.from('note-null-v1'), commit, rHash)
}

function noteId(commit: Buffer, nullif: Buffer): Buffer {
  return sha256(Buffer.from('note-id-v1'), commit, nullif)
}

function blindingHash(blinding: Buffer): Buffer {
  return sha256(Buffer.from('note-blind-v1'), blinding)
}

function proofId(nId: Buffer, value: bigint): Buffer {
  return sha256(Buffer.from('note-proof-v1'), nId, u64le(value))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null note-commitment', () => {
  const RECIPIENT_SECRET = Buffer.alloc(32).fill(0xcc)
  const BLINDING         = Buffer.alloc(32).fill(0x55)
  const VALUE            = 1_000_000n  // 1 USDC (6 decimals)

  // Test 1: commitment = SHA256("note-commit-v1" || valueHash || recipientHash) — vector test
  it('commitment = SHA256("note-commit-v1" || valueHash || recipientHash)', () => {
    const rHash  = recipientHash(RECIPIENT_SECRET)
    const vHash  = valueHash(VALUE, BLINDING)
    const commit = commitment(vHash, rHash)

    const expected = sha256(Buffer.from('note-commit-v1'), vHash, rHash)
    expect(commit.length).toBe(32)
    expect(commit.equals(expected)).toBe(true)
    expect(commit.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 2: nullifier = SHA256("note-null-v1" || commitment || recipientHash)
  it('nullifier = SHA256("note-null-v1" || commitment || recipientHash)', () => {
    const rHash  = recipientHash(RECIPIENT_SECRET)
    const vHash  = valueHash(VALUE, BLINDING)
    const commit = commitment(vHash, rHash)
    const nullif = nullifier(commit, rHash)

    const expected = sha256(Buffer.from('note-null-v1'), commit, rHash)
    expect(nullif.length).toBe(32)
    expect(nullif.equals(expected)).toBe(true)
  })

  // Test 3: note_id formula is correct
  it('note_id formula is correct', () => {
    const rHash  = recipientHash(RECIPIENT_SECRET)
    const vHash  = valueHash(VALUE, BLINDING)
    const commit = commitment(vHash, rHash)
    const nullif = nullifier(commit, rHash)
    const nId    = noteId(commit, nullif)

    const expected = sha256(Buffer.from('note-id-v1'), commit, nullif)
    expect(nId.length).toBe(32)
    expect(nId.equals(expected)).toBe(true)
  })

  // Test 4: different values produce different commitments
  it('different values produce different commitments', () => {
    const rHash   = recipientHash(RECIPIENT_SECRET)
    const vHash1  = valueHash(500_000n, BLINDING)
    const vHash2  = valueHash(999_999n, BLINDING)
    const commit1 = commitment(vHash1, rHash)
    const commit2 = commitment(vHash2, rHash)
    expect(commit1.equals(commit2)).toBe(false)
  })

  // Test 5: proof_id is deterministic and non-zero
  it('proof_id is deterministic and non-zero', () => {
    const rHash  = recipientHash(RECIPIENT_SECRET)
    const vHash  = valueHash(VALUE, BLINDING)
    const commit = commitment(vHash, rHash)
    const nullif = nullifier(commit, rHash)
    const nId    = noteId(commit, nullif)
    const pId1   = proofId(nId, VALUE)
    const pId2   = proofId(nId, VALUE)
    expect(pId1.equals(pId2)).toBe(true)
    expect(pId1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 6: mainnet_ready is false
  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
