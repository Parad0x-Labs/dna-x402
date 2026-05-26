import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Primitives matching Rust sovereign-proof crate
// ---------------------------------------------------------------------------

function ownerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('sov-owner-v1'), secret)
}

function dataHash(data: Buffer): Buffer {
  return sha256(Buffer.from('sov-data-v1'), data)
}

function domainHash(domain: Buffer): Buffer {
  return sha256(Buffer.from('sov-domain-v1'), domain)
}

function dataCommitment(dh: Buffer, blinding: Buffer, oh: Buffer): Buffer {
  return sha256(Buffer.from('sov-commit-v1'), dh, blinding, oh)
}

function proofId(oh: Buffer, dc: Buffer, dom: Buffer, issuedAt: bigint): Buffer {
  return sha256(Buffer.from('sov-proof-v1'), oh, dc, dom, i64le(issuedAt))
}

interface SovereignProof {
  proof_id: Buffer
  domain_hash: Buffer
  issued_at: bigint
  valid: boolean
  mainnet_ready: boolean
  // internal — not in public record
  _owner_hash: Buffer
  _data_commitment: Buffer
}

function newProof(
  ownerSecret: Buffer,
  data: Buffer,
  blinding: Buffer,
  domain: Buffer,
  issuedAt: bigint,
): SovereignProof {
  const oh = ownerHash(ownerSecret)
  const dh = dataHash(data)
  const dom = domainHash(domain)
  const dc = dataCommitment(dh, blinding, oh)
  const pid = proofId(oh, dc, dom, issuedAt)
  return {
    proof_id: pid,
    domain_hash: dom,
    issued_at: issuedAt,
    valid: true,
    mainnet_ready: false,
    _owner_hash: oh,
    _data_commitment: dc,
  }
}

function updateDomain(proof: SovereignProof, ownerSecret: Buffer, data: Buffer, blinding: Buffer, newDomain: Buffer): SovereignProof {
  const oh = ownerHash(ownerSecret)
  const dh = dataHash(data)
  const dom = domainHash(newDomain)
  const dc = dataCommitment(dh, blinding, oh)
  const pid = proofId(oh, dc, dom, proof.issued_at)
  return {
    ...proof,
    proof_id: pid,
    domain_hash: dom,
    _owner_hash: oh,
    _data_commitment: dc,
  }
}

function publicRecord(p: SovereignProof) {
  return {
    proof_id: p.proof_id.toString('hex'),
    domain_hash: p.domain_hash.toString('hex'),
    issued_at: p.issued_at.toString(),
    valid: p.valid,
    mainnet_ready: p.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const OWNER_SECRET = Buffer.from('owner-secret-xyz')
const DATA = Buffer.from('my private sovereign data')
const BLINDING = Buffer.alloc(32, 0x77)
const DOMAIN = Buffer.from('example.com')
const DOMAIN2 = Buffer.from('other-domain.net')
const ISSUED_AT = 1_700_000_000n

describe('dark-null.sovereign-proof', () => {
  it('proof_id formula is correct (all layers)', () => {
    const oh = ownerHash(OWNER_SECRET)
    const dh = dataHash(DATA)
    const dom = domainHash(DOMAIN)
    const dc = dataCommitment(dh, BLINDING, oh)
    const expected = sha256(Buffer.from('sov-proof-v1'), oh, dc, dom, i64le(ISSUED_AT))

    const proof = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    expect(proof.proof_id.toString('hex')).toBe(expected.toString('hex'))
    expect(proof.proof_id.length).toBe(32)
  })

  it('different domains produce different proof_ids', () => {
    const p1 = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    const p2 = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN2, ISSUED_AT)
    expect(p1.proof_id.toString('hex')).not.toBe(p2.proof_id.toString('hex'))
    expect(p1.domain_hash.toString('hex')).not.toBe(p2.domain_hash.toString('hex'))
  })

  it('update_domain recomputes domain_hash and proof_id', () => {
    const p1 = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    const p2 = updateDomain(p1, OWNER_SECRET, DATA, BLINDING, DOMAIN2)

    // domain_hash changes
    expect(p1.domain_hash.toString('hex')).not.toBe(p2.domain_hash.toString('hex'))
    // proof_id changes
    expect(p1.proof_id.toString('hex')).not.toBe(p2.proof_id.toString('hex'))
    // issued_at preserved
    expect(p2.issued_at).toBe(ISSUED_AT)
    // new domain_hash matches expected
    const expectedDom = domainHash(DOMAIN2)
    expect(p2.domain_hash.toString('hex')).toBe(expectedDom.toString('hex'))
  })

  it('data_commitment hides the actual data', () => {
    const proof = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    const rec = publicRecord(proof)
    // Public record should not expose the raw data
    expect(rec).not.toHaveProperty('data')
    expect(rec).not.toHaveProperty('_data_commitment')
    // The commitment is stored internally but not emitted
    expect(proof._data_commitment.length).toBe(32)
    expect(proof._data_commitment.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('proof is valid after construction', () => {
    const proof = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    expect(proof.valid).toBe(true)
    expect(proof.proof_id.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('public record hides owner_hash and data_commitment, mainnet_ready=false', () => {
    const proof = newProof(OWNER_SECRET, DATA, BLINDING, DOMAIN, ISSUED_AT)
    const rec = publicRecord(proof)
    expect(rec).not.toHaveProperty('owner_hash')
    expect(rec).not.toHaveProperty('_owner_hash')
    expect(rec).not.toHaveProperty('data_commitment')
    expect(rec).not.toHaveProperty('_data_commitment')
    expect(rec.mainnet_ready).toBe(false)
    expect(rec).toHaveProperty('proof_id')
    expect(rec).toHaveProperty('domain_hash')
  })
})
