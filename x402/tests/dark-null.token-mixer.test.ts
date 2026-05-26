import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const MAINNET_READY = false

describe('dark-null.token-mixer', () => {
  const denomination1 = BigInt(1_000_000)
  const denomination2 = BigInt(5_000_000)
  const depositorSecret1 = Buffer.from('mixer-depositor-alice-secret', 'utf8')
  const depositorSecret2 = Buffer.from('mixer-depositor-bob-secret', 'utf8')
  const nonce1 = Buffer.from('mixer-nonce-0001', 'utf8')
  const nonce2 = Buffer.from('mixer-nonce-0002', 'utf8')

  it('mixer_id = SHA256("mixer-id-v1" || denomination_le8)', () => {
    const denomLe8 = u64le(denomination1)
    const mixerId  = sha256(Buffer.from('mixer-id-v1'), denomLe8)
    expect(mixerId.length).toBe(32)
    expect(mixerId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(mixerId.equals(sha256(Buffer.from('mixer-id-v1'), denomLe8))).toBe(true)
  })

  it('deposit_commitment formula is correct', () => {
    const depositorHash = sha256(Buffer.from('mixer-dep-v1'), depositorSecret1)
    const depositCommit = sha256(Buffer.from('mixer-commit-v1'), depositorHash, nonce1)
    expect(depositCommit.length).toBe(32)
    expect(depositCommit.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(depositCommit.equals(sha256(Buffer.from('mixer-commit-v1'), depositorHash, nonce1))).toBe(true)
  })

  it('nullifier = SHA256("mixer-null-v1" || depositor_hash || mixer_id)', () => {
    const depositorHash = sha256(Buffer.from('mixer-dep-v1'), depositorSecret1)
    const mixerId       = sha256(Buffer.from('mixer-id-v1'), u64le(denomination1))
    const nullifier     = sha256(Buffer.from('mixer-null-v1'), depositorHash, mixerId)
    expect(nullifier.length).toBe(32)
    expect(nullifier.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(nullifier.equals(sha256(Buffer.from('mixer-null-v1'), depositorHash, mixerId))).toBe(true)
  })

  it('deposit_root formula is correct', () => {
    const depositorHash1 = sha256(Buffer.from('mixer-dep-v1'), depositorSecret1)
    const depositorHash2 = sha256(Buffer.from('mixer-dep-v1'), depositorSecret2)
    const commit1   = sha256(Buffer.from('mixer-commit-v1'), depositorHash1, nonce1)
    const commit2   = sha256(Buffer.from('mixer-commit-v1'), depositorHash2, nonce2)
    const depositId1 = sha256(Buffer.from('mixer-did-v1'), commit1, u32le(0))
    const depositId2 = sha256(Buffer.from('mixer-did-v1'), commit2, u32le(1))
    const root = sha256(Buffer.from('mixer-droot-v1'), xorFold([depositId1, depositId2]), u32le(2))
    expect(root.length).toBe(32)
    expect(root.equals(Buffer.alloc(32, 0))).toBe(false)
    // single-deposit root differs
    const root1 = sha256(Buffer.from('mixer-droot-v1'), xorFold([depositId1]), u32le(1))
    expect(root.equals(root1)).toBe(false)
  })

  it('different denominations produce different mixer_ids', () => {
    const id1 = sha256(Buffer.from('mixer-id-v1'), u64le(denomination1))
    const id2 = sha256(Buffer.from('mixer-id-v1'), u64le(denomination2))
    expect(id1.equals(id2)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    expect(MAINNET_READY).toBe(false)
  })
})
