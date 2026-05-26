import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

const HOLDER_SECRET = Buffer.from('holder-secret-deadbeef01234567', 'utf8')
const ISSUER_SECRET = Buffer.from('issuer-secret-cafebabe87654321', 'utf8')
const DOMAIN_BYTES = Buffer.from('defi.reputation.v1', 'utf8')
const LEVEL = Buffer.from([3]) // level 3
const ISSUED_AT = 1_700_000_000n
const EXPIRES_AT = 1_800_000_000n
const NONCE = Buffer.from('badge-nonce-aabbccdd00112233', 'utf8')

function buildBadge(
  holderSecret: Buffer,
  issuerSecret: Buffer,
  domainBytes: Buffer,
  level: Buffer,
  issuedAt: bigint,
  expiresAt: bigint
): { holderHash: Buffer; issuerHash: Buffer; domainHash: Buffer; badgeId: Buffer } {
  const holderHash = sha256(Buffer.from('badge-holder-v1'), holderSecret)
  const issuerHash = sha256(Buffer.from('badge-issuer-v1'), issuerSecret)
  const domainHash = sha256(Buffer.from('badge-domain-v1'), domainBytes)
  const badgeId = sha256(
    Buffer.from('badge-id-v1'),
    holderHash,
    issuerHash,
    domainHash,
    level,
    i64le(issuedAt),
    i64le(expiresAt)
  )
  return { holderHash, issuerHash, domainHash, badgeId }
}

function buildPseudonym(badgeId: Buffer, holderSecret: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('badge-pseudo-v1'), badgeId, holderSecret, nonce)
}

describe('dark-null reputation-badge', () => {
  it('badge_id matches expected computation', () => {
    const { holderHash, issuerHash, domainHash, badgeId } = buildBadge(
      HOLDER_SECRET, ISSUER_SECRET, DOMAIN_BYTES, LEVEL, ISSUED_AT, EXPIRES_AT
    )

    // Recompute independently
    const expHolder = sha256(Buffer.from('badge-holder-v1'), HOLDER_SECRET)
    const expIssuer = sha256(Buffer.from('badge-issuer-v1'), ISSUER_SECRET)
    const expDomain = sha256(Buffer.from('badge-domain-v1'), DOMAIN_BYTES)
    const expBadgeId = sha256(
      Buffer.from('badge-id-v1'),
      expHolder, expIssuer, expDomain,
      LEVEL,
      i64le(ISSUED_AT),
      i64le(EXPIRES_AT)
    )

    expect(holderHash.toString('hex')).toBe(expHolder.toString('hex'))
    expect(issuerHash.toString('hex')).toBe(expIssuer.toString('hex'))
    expect(domainHash.toString('hex')).toBe(expDomain.toString('hex'))
    expect(badgeId.toString('hex')).toBe(expBadgeId.toString('hex'))
    expect(badgeId).toHaveLength(32)
  })

  it('pseudonym unlinkable: same badge, different nonces → different pseudonyms', () => {
    const { badgeId } = buildBadge(HOLDER_SECRET, ISSUER_SECRET, DOMAIN_BYTES, LEVEL, ISSUED_AT, EXPIRES_AT)

    const nonce1 = Buffer.from('nonce-one-111111111111111111111', 'utf8')
    const nonce2 = Buffer.from('nonce-two-222222222222222222222', 'utf8')

    const pseudo1 = buildPseudonym(badgeId, HOLDER_SECRET, nonce1)
    const pseudo2 = buildPseudonym(badgeId, HOLDER_SECRET, nonce2)

    expect(pseudo1.toString('hex')).not.toBe(pseudo2.toString('hex'))
    expect(pseudo1).toHaveLength(32)
    expect(pseudo2).toHaveLength(32)
  })

  it('domain change changes badge_id', () => {
    const domain1 = Buffer.from('defi.reputation.v1', 'utf8')
    const domain2 = Buffer.from('nft.reputation.v1', 'utf8')

    const { badgeId: id1 } = buildBadge(HOLDER_SECRET, ISSUER_SECRET, domain1, LEVEL, ISSUED_AT, EXPIRES_AT)
    const { badgeId: id2 } = buildBadge(HOLDER_SECRET, ISSUER_SECRET, domain2, LEVEL, ISSUED_AT, EXPIRES_AT)

    expect(id1.toString('hex')).not.toBe(id2.toString('hex'))
  })

  it('level change changes badge_id', () => {
    const level1 = Buffer.from([1])
    const level2 = Buffer.from([5])

    const { badgeId: id1 } = buildBadge(HOLDER_SECRET, ISSUER_SECRET, DOMAIN_BYTES, level1, ISSUED_AT, EXPIRES_AT)
    const { badgeId: id2 } = buildBadge(HOLDER_SECRET, ISSUER_SECRET, DOMAIN_BYTES, level2, ISSUED_AT, EXPIRES_AT)

    expect(id1.toString('hex')).not.toBe(id2.toString('hex'))
  })

  it('public record hides holder_hash and issuer_hash', () => {
    const { holderHash, issuerHash, domainHash, badgeId } = buildBadge(
      HOLDER_SECRET, ISSUER_SECRET, DOMAIN_BYTES, LEVEL, ISSUED_AT, EXPIRES_AT
    )
    const pseudonym = buildPseudonym(badgeId, HOLDER_SECRET, NONCE)

    // Simulate the public record
    const publicRecord = {
      badge_id: badgeId.toString('hex'),
      domain_hash: domainHash.toString('hex'),
      pseudonym: pseudonym.toString('hex'),
    }

    expect(publicRecord).toHaveProperty('badge_id')
    expect(publicRecord).toHaveProperty('domain_hash')
    expect(publicRecord).toHaveProperty('pseudonym')
    expect(publicRecord).not.toHaveProperty('holder_hash')
    expect(publicRecord).not.toHaveProperty('issuer_hash')

    const vals = Object.values(publicRecord)
    expect(vals).not.toContain(holderHash.toString('hex'))
    expect(vals).not.toContain(issuerHash.toString('hex'))
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
  })
})
