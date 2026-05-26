import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u8(n: number): Buffer { return Buffer.from([n]) }

// ---------------------------------------------------------------------------
// n-of-n XOR secret sharing
// Mirrors crates/dark-secret-sharing/src/lib.rs
// ---------------------------------------------------------------------------

interface ShareSet {
  /** Raw share bytes, one per party (each 32 bytes) */
  shares: Buffer[]
  /** SHA256 commitment per share */
  shareCommitments: Buffer[]
}

/**
 * Split a 32-byte secret into n shares using the n-of-n XOR scheme.
 *
 * for i in 0..(n-1):
 *   partial[i] = SHA256("partial-v1" || secret || nonce || [i])
 * share[n-1] = secret XOR partial[0] XOR ... XOR partial[n-2]
 * shares[0..n-2] = partial[0..n-2]
 *
 * share_commitment[i] = SHA256("share-commit-v1" || [i] || share_bytes[i])
 */
function splitSecret(secret: Buffer, nonce: Buffer, n: number): ShareSet {
  if (n < 2) throw new Error('n must be >= 2')

  // Compute the n-1 pseudo-random partials
  const partials: Buffer[] = []
  for (let i = 0; i < n - 1; i++) {
    partials.push(sha256(Buffer.from('partial-v1'), secret, nonce, u8(i)))
  }

  // Last share = secret XOR all partials
  let lastShare = Buffer.from(secret)
  for (const p of partials) {
    for (let j = 0; j < lastShare.length; j++) lastShare[j] ^= p[j]
  }

  const shares = [...partials, lastShare]

  const shareCommitments = shares.map((s, i) =>
    sha256(Buffer.from('share-commit-v1'), u8(i), s),
  )

  return { shares, shareCommitments }
}

/**
 * Reconstruct the secret from all n shares.
 * XOR all share_bytes → recovers the original secret.
 */
function reconstructSecret(shares: Buffer[]): Buffer {
  const acc = Buffer.from(shares[0])
  for (let i = 1; i < shares.length; i++) {
    for (let j = 0; j < acc.length; j++) acc[j] ^= shares[i][j]
  }
  return acc
}

/**
 * The "public record" for a party — contains only the party index and
 * the share commitment; never the raw share bytes.
 */
interface PublicShareRecord {
  party_id: number
  share_commitment: string // hex
}

function toPublicRecord(shareSet: ShareSet): PublicShareRecord[] {
  return shareSet.shareCommitments.map((c, i) => ({
    party_id: i,
    share_commitment: c.toString('hex'),
  }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null secret-sharing', () => {
  const SECRET = sha256(Buffer.from('test-secret-input'))
  const NONCE  = sha256(Buffer.from('test-nonce-seed'))

  it('2-of-2 split and reconstruct', () => {
    const { shares } = splitSecret(SECRET, NONCE, 2)
    expect(shares).toHaveLength(2)
    const recovered = reconstructSecret(shares)
    expect(recovered.equals(SECRET)).toBe(true)
  })

  it('3-of-3 split and reconstruct', () => {
    const { shares } = splitSecret(SECRET, NONCE, 3)
    expect(shares).toHaveLength(3)
    const recovered = reconstructSecret(shares)
    expect(recovered.equals(SECRET)).toBe(true)
  })

  it('5-of-5 split and reconstruct', () => {
    const { shares } = splitSecret(SECRET, NONCE, 5)
    expect(shares).toHaveLength(5)
    const recovered = reconstructSecret(shares)
    expect(recovered.equals(SECRET)).toBe(true)
  })

  it('share commitments are verifiable — recompute and check', () => {
    const { shares, shareCommitments } = splitSecret(SECRET, NONCE, 3)
    for (let i = 0; i < shares.length; i++) {
      const recomputed = sha256(Buffer.from('share-commit-v1'), u8(i), shares[i])
      expect(recomputed.equals(shareCommitments[i])).toBe(true)
    }
  })

  it('different nonces produce different shares — same secret, different nonce', () => {
    const NONCE2 = sha256(Buffer.from('different-nonce'))
    const set1 = splitSecret(SECRET, NONCE,  3)
    const set2 = splitSecret(SECRET, NONCE2, 3)

    // Every partial share should differ (overwhelmingly likely with SHA256)
    for (let i = 0; i < set1.shares.length; i++) {
      expect(set1.shares[i].equals(set2.shares[i])).toBe(false)
    }

    // But both sets still reconstruct to the same secret
    expect(reconstructSecret(set1.shares).equals(SECRET)).toBe(true)
    expect(reconstructSecret(set2.shares).equals(SECRET)).toBe(true)
  })

  it('public record hides share bytes — JSON has party_id and share_commitment; no share_bytes hex', () => {
    const { shares, shareCommitments } = splitSecret(SECRET, NONCE, 3)
    const records = toPublicRecord({ shares, shareCommitments })
    const json = JSON.stringify(records)

    // Public records contain the expected fields
    for (const r of records) {
      expect(r).toHaveProperty('party_id')
      expect(r).toHaveProperty('share_commitment')
      expect(typeof r.share_commitment).toBe('string')
      expect(r.share_commitment).toHaveLength(64) // 32 bytes → 64 hex chars
    }

    // Raw share bytes must not appear verbatim in the public JSON
    for (const share of shares) {
      expect(json).not.toContain(share.toString('hex'))
    }
  })
})
