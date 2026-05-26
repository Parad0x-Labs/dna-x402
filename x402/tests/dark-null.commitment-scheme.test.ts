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
// CommitmentScheme (mirrors crates/dark-commitment-scheme/src/lib.rs)
//
// value_hash    = SHA256("cs-value-v1"  || value_bytes)
// blinding_hash = SHA256("cs-blind-v1"  || blinding)
// commitment    = SHA256("cs-commit-v1" || value_hash || blinding_hash)
//
// Errors: EmptyValue, ZeroBlinding
// mainnet_ready = false always
// ---------------------------------------------------------------------------

interface Commitment {
  value_hash: Buffer
  blinding_hash: Buffer
  commitment: Buffer
  mainnet_ready: boolean
}

function computeValueHash(value: Buffer): Buffer {
  return sha256(Buffer.from('cs-value-v1'), value)
}

function computeBlindingHash(blinding: Buffer): Buffer {
  return sha256(Buffer.from('cs-blind-v1'), blinding)
}

function computeCommitment(valueHash: Buffer, blindingHash: Buffer): Buffer {
  return sha256(Buffer.from('cs-commit-v1'), valueHash, blindingHash)
}

function commit(value: Buffer, blinding: Buffer): Commitment {
  if (value.length === 0) throw new Error('EmptyValue')
  if (blinding.equals(Buffer.alloc(32, 0))) throw new Error('ZeroBlinding')
  const valueHash = computeValueHash(value)
  const blindingHash = computeBlindingHash(blinding)
  const commitment = computeCommitment(valueHash, blindingHash)
  return { value_hash: valueHash, blinding_hash: blindingHash, commitment, mainnet_ready: false }
}

function openVerify(c: Commitment, value: Buffer, blinding: Buffer): boolean {
  const vh = computeValueHash(value)
  const bh = computeBlindingHash(blinding)
  const recomputed = computeCommitment(vh, bh)
  return recomputed.equals(c.commitment)
}

function commitmentPublicRecord(c: Commitment): object {
  return {
    commitment: c.commitment.toString('hex'),
    mainnet_ready: c.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null commitment-scheme', () => {
  const BLINDING = Buffer.alloc(32); BLINDING[0] = 0xca; BLINDING[1] = 0xfe
  const VALUE = Buffer.from('secret-value-42')

  it('commitment computation is correct', () => {
    const c = commit(VALUE, BLINDING)
    expect(c.commitment.length).toBe(32)
    expect(c.mainnet_ready).toBe(false)
    const vh = computeValueHash(VALUE)
    const bh = computeBlindingHash(BLINDING)
    const expected = computeCommitment(vh, bh)
    expect(c.commitment.equals(expected)).toBe(true)
  })

  it('open verify passes with correct value and blinding', () => {
    const c = commit(VALUE, BLINDING)
    expect(openVerify(c, VALUE, BLINDING)).toBe(true)
  })

  it('tampered value fails verification', () => {
    const c = commit(VALUE, BLINDING)
    expect(openVerify(c, Buffer.from('tampered-value'), BLINDING)).toBe(false)
  })

  it('zero blinding is rejected', () => {
    expect(() => commit(VALUE, Buffer.alloc(32, 0))).toThrow('ZeroBlinding')
  })

  it('public record hides value_hash and blinding_hash', () => {
    const c = commit(VALUE, BLINDING)
    const rec = commitmentPublicRecord(c) as Record<string, unknown>
    expect(rec['commitment']).toBe(c.commitment.toString('hex'))
    expect(rec['mainnet_ready']).toBe(false)
    expect(rec['value_hash']).toBeUndefined()
    expect(rec['blinding_hash']).toBeUndefined()
  })

  it('mainnet_ready=false always', () => {
    const c = commit(Buffer.from('anything'), BLINDING)
    expect(c.mainnet_ready).toBe(false)
  })
})
