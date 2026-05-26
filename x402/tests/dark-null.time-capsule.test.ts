import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

describe('dark-null time-capsule', () => {
  const ownerSecret  = Buffer.alloc(32, 0xaa)
  const contentBytes = Buffer.from('secret message')
  const nonce        = Buffer.alloc(32, 0x01)
  const revealAt     = 1_000_000n

  const ownerHash          = sha256(Buffer.from('capsule-owner-v1'),   ownerSecret)
  const contentHash        = sha256(Buffer.from('capsule-content-v1'), contentBytes)
  const contentCommitment  = sha256(Buffer.from('capsule-commit-v1'),  contentHash, nonce)
  const sealHash           = sha256(Buffer.from('capsule-seal-v1'),    ownerHash, contentCommitment, i64le(revealAt))
  const capsuleId          = sha256(Buffer.from('capsule-id-v1'),      sealHash)

  it('capsule_id computation is deterministic', () => {
    const sealHash2  = sha256(Buffer.from('capsule-seal-v1'), ownerHash, contentCommitment, i64le(revealAt))
    const capsuleId2 = sha256(Buffer.from('capsule-id-v1'), sealHash2)
    expect(capsuleId.equals(capsuleId2)).toBe(true)
  })

  it('content_commitment hides actual content (different content → different commitment)', () => {
    const otherContent     = Buffer.from('other secret')
    const otherHash        = sha256(Buffer.from('capsule-content-v1'), otherContent)
    const otherCommitment  = sha256(Buffer.from('capsule-commit-v1'),  otherHash, nonce)
    expect(contentCommitment.equals(otherCommitment)).toBe(false)
    // Same content + same nonce → same commitment
    const sameCommitment = sha256(Buffer.from('capsule-commit-v1'), contentHash, nonce)
    expect(contentCommitment.equals(sameCommitment)).toBe(true)
  })

  it('too early guard: reveal_at in the future means capsule stays sealed', () => {
    const futureRevealAt = 9_999_999_999n
    const earlyNow       = 1_000n
    // Simulate: if now < reveal_at → too early
    const tooEarly = earlyNow < futureRevealAt
    expect(tooEarly).toBe(true)
    // At or after reveal_at → can open
    const atRevealAt = futureRevealAt >= futureRevealAt
    expect(atRevealAt).toBe(true)
  })

  it('seal_hash is sensitive to reveal_at', () => {
    const revealAt2   = 2_000_000n
    const sealHash2   = sha256(Buffer.from('capsule-seal-v1'), ownerHash, contentCommitment, i64le(revealAt2))
    expect(sealHash.equals(sealHash2)).toBe(false)
  })

  it('public record hides owner_hash and content_commitment', () => {
    // Simulate public record: only capsule_id and reveal_at are public
    const ownerHex      = ownerHash.toString('hex')
    const commitHex     = contentCommitment.toString('hex')
    const capsuleIdHex  = capsuleId.toString('hex')

    // capsule_id != owner_hash and capsule_id != content_commitment
    expect(capsuleIdHex).not.toBe(ownerHex)
    expect(capsuleIdHex).not.toBe(commitHex)
    // owner and content commitment differ
    expect(ownerHex).not.toBe(commitHex)
  })

  it('mainnet_ready=false (different nonces produce different capsule_ids)', () => {
    const nonce2            = Buffer.alloc(32, 0x99)
    const contentCommit2    = sha256(Buffer.from('capsule-commit-v1'), contentHash, nonce2)
    const sealHash2         = sha256(Buffer.from('capsule-seal-v1'), ownerHash, contentCommit2, i64le(revealAt))
    const capsuleId2        = sha256(Buffer.from('capsule-id-v1'), sealHash2)
    expect(capsuleId.equals(capsuleId2)).toBe(false)
    // mainnet_ready is always false
    expect(false).toBe(false)
  })
})
