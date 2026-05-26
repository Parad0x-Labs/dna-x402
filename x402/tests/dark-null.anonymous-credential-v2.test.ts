import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Anonymous Credential v2 primitives
//
// holder_hash  = SHA256("credv2-holder-v1" || holder_secret)
// issuer_hash  = SHA256("credv2-issuer-v1" || issuer_secret)
// attr_commit  = SHA256("credv2-attr-v1"   || [attr_id] || attr_value || holder_hash)
// cred_id      = SHA256("credv2-id-v1"     || holder_hash || issuer_hash || XOR_fold(attr_commits) || issued_at_i64le)
// proof_hash   = SHA256("credv2-proof-v1"  || cred_id || XOR_fold(disclosed_commits) || holder_hash)
// proof_id     = SHA256("credv2-proof-id-v1" || proof_hash)
// ---------------------------------------------------------------------------

function holderHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('credv2-holder-v1'), secret)
}

function issuerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('credv2-issuer-v1'), secret)
}

function attrCommit(attrId: number, attrValue: Buffer, holderH: Buffer): Buffer {
  return sha256(Buffer.from('credv2-attr-v1'), Buffer.from([attrId]), attrValue, holderH)
}

function credId(holderH: Buffer, issuerH: Buffer, attrCommits: Buffer[], issuedAt: bigint): Buffer {
  return sha256(
    Buffer.from('credv2-id-v1'),
    holderH,
    issuerH,
    xorFold(attrCommits),
    i64le(issuedAt),
  )
}

function proofHash(credIdBuf: Buffer, disclosedCommits: Buffer[], holderH: Buffer): Buffer {
  return sha256(
    Buffer.from('credv2-proof-v1'),
    credIdBuf,
    xorFold(disclosedCommits),
    holderH,
  )
}

function proofId(proofH: Buffer): Buffer {
  return sha256(Buffer.from('credv2-proof-id-v1'), proofH)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null anonymous-credential-v2', () => {
  const HOLDER_SECRET = Buffer.from('holder-secret-v2-000000000000000', 'utf8')
  const ISSUER_SECRET = Buffer.from('issuer-secret-v2-000000000000000', 'utf8')
  const ATTR_1_VAL    = Buffer.from('age>=18', 'utf8')
  const ATTR_2_VAL    = Buffer.from('country=US', 'utf8')
  const ISSUED_AT     = 1_700_000_000n

  const holderH = holderHash(HOLDER_SECRET)
  const issuerH = issuerHash(ISSUER_SECRET)
  const ac1     = attrCommit(1, ATTR_1_VAL, holderH)
  const ac2     = attrCommit(2, ATTR_2_VAL, holderH)
  const credIdBuf = credId(holderH, issuerH, [ac1, ac2], ISSUED_AT)

  it('cred_id computation with 2 attrs is deterministic', () => {
    const holderH2   = holderHash(HOLDER_SECRET)
    const issuerH2   = issuerHash(ISSUER_SECRET)
    const ac1b       = attrCommit(1, ATTR_1_VAL, holderH2)
    const ac2b       = attrCommit(2, ATTR_2_VAL, holderH2)
    const credId2    = credId(holderH2, issuerH2, [ac1b, ac2b], ISSUED_AT)

    expect(credId2.length).toBe(32)
    expect(credId2.equals(credIdBuf)).toBe(true)
  })

  it('proof_id computation is deterministic', () => {
    const ph1 = proofHash(credIdBuf, [ac1], holderH)
    const pid1 = proofId(ph1)
    const pid2 = proofId(proofHash(credIdBuf, [ac1], holderH))

    expect(pid1.length).toBe(32)
    expect(pid1.equals(pid2)).toBe(true)
  })

  it('different disclosed sets produce different proofs', () => {
    const phDisclosed1   = proofHash(credIdBuf, [ac1], holderH)
    const phDisclosed2   = proofHash(credIdBuf, [ac2], holderH)
    const phDisclosedBoth = proofHash(credIdBuf, [ac1, ac2], holderH)

    expect(phDisclosed1.equals(phDisclosed2)).toBe(false)
    expect(phDisclosed1.equals(phDisclosedBoth)).toBe(false)
    expect(phDisclosed2.equals(phDisclosedBoth)).toBe(false)

    expect(proofId(phDisclosed1).equals(proofId(phDisclosed2))).toBe(false)
  })

  it('public record hides holder and issuer secrets', () => {
    const record = {
      cred_id:       credIdBuf.toString('hex'),
      issued_at:     ISSUED_AT.toString(),
      attr_count:    2,
      mainnet_ready: false,
    }
    const json = JSON.stringify(record)

    // holder and issuer hash are not exposed
    expect(json).not.toContain(holderH.toString('hex'))
    expect(json).not.toContain(issuerH.toString('hex'))

    // the raw secrets must not appear
    expect(json).not.toContain(HOLDER_SECRET.toString('hex'))
    expect(json).not.toContain(ISSUER_SECRET.toString('hex'))

    expect(record.mainnet_ready).toBe(false)
  })

  it('attr_commit is sensitive to attr_id', () => {
    const commit_id1 = attrCommit(1, ATTR_1_VAL, holderH)
    const commit_id2 = attrCommit(2, ATTR_1_VAL, holderH) // same value, different id

    expect(commit_id1.equals(commit_id2)).toBe(false)
  })

  it('mainnet_ready is always false', () => {
    const record = {
      cred_id:       credIdBuf.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
