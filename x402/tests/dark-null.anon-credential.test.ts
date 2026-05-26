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

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Anon-credential primitives (mirrors crates/dark-anon-credential)
//
// issuer_hash       = SHA256("anon-issuer-v1"   || issuer_secret)
// attribute_hash    = SHA256("anon-attr-v1"      || attribute_bytes)
// credential_id     = SHA256("anon-cred-id-v1"   || issuer_hash || attribute_hash || issued_at_le[8])
// pseudonym         = SHA256("anon-present-v1"   || credential_id || holder_secret || presentation_nonce)
// presentation_proof= SHA256("anon-proof-v1"     || pseudonym     || attribute_hash || presentation_nonce)
// ---------------------------------------------------------------------------

const PFX_ISSUER  = Buffer.from('anon-issuer-v1')
const PFX_ATTR    = Buffer.from('anon-attr-v1')
const PFX_CRED    = Buffer.from('anon-cred-id-v1')
const PFX_PRESENT = Buffer.from('anon-present-v1')
const PFX_PROOF   = Buffer.from('anon-proof-v1')

function issuerHash(secret: Buffer): Buffer {
  return sha256(PFX_ISSUER, secret)
}

function attributeHash(attributeBytes: Buffer): Buffer {
  if (attributeBytes.length === 0) throw new Error('attribute empty rejected')
  return sha256(PFX_ATTR, attributeBytes)
}

function credentialId(
  iHash: Buffer,
  attrHash: Buffer,
  issuedAt: bigint,
): Buffer {
  return sha256(PFX_CRED, iHash, attrHash, u64le(issuedAt))
}

function pseudonym(
  credId: Buffer,
  holderSecret: Buffer,
  presentationNonce: Buffer,
): Buffer {
  if (presentationNonce.equals(Buffer.alloc(presentationNonce.length))) {
    throw new Error('zero nonce rejected')
  }
  return sha256(PFX_PRESENT, credId, holderSecret, presentationNonce)
}

function presentationProof(
  pseu: Buffer,
  attrHash: Buffer,
  presentationNonce: Buffer,
): Buffer {
  return sha256(PFX_PROOF, pseu, attrHash, presentationNonce)
}

// ---------------------------------------------------------------------------
// Issue + Present + Verify
// ---------------------------------------------------------------------------
interface Credential {
  credentialId: Buffer
  issuerHashHex: string
  attributeHash: Buffer
  issuedAt: bigint
}

function issueCredential(
  issuerSecret: Buffer,
  attributeBytes: Buffer,
  issuedAt: bigint,
): Credential {
  const iHash  = issuerHash(issuerSecret)
  const aHash  = attributeHash(attributeBytes)
  const credId = credentialId(iHash, aHash, issuedAt)
  return {
    credentialId:  credId,
    issuerHashHex: iHash.toString('hex'),
    attributeHash: aHash,
    issuedAt,
  }
}

interface Presentation {
  pseudonym: Buffer
  proof: Buffer
  presentationNonce: Buffer
}

function present(
  cred: Credential,
  holderSecret: Buffer,
  nonce: Buffer,
): Presentation {
  const pseu  = pseudonym(cred.credentialId, holderSecret, nonce)
  const proof = presentationProof(pseu, cred.attributeHash, nonce)
  return { pseudonym: pseu, proof, presentationNonce: nonce }
}

function verifyPresentation(
  cred: Credential,
  holderSecret: Buffer,
  pres: Presentation,
): boolean {
  // Recompute pseudonym and proof and compare
  const expectedPseu  = pseudonym(cred.credentialId, holderSecret, pres.presentationNonce)
  const expectedProof = presentationProof(expectedPseu, cred.attributeHash, pres.presentationNonce)
  return expectedPseu.equals(pres.pseudonym) && expectedProof.equals(pres.proof)
}

function publicRecord(cred: Credential, pres: Presentation): object {
  return {
    credential_id:     cred.credentialId.toString('hex'),
    pseudonym_hex:     pres.pseudonym.toString('hex'),
    proof_hex:         pres.proof.toString('hex'),
    // issuer_hash hidden
    issuer_hash:       null,
    mainnet_ready:     false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null anon-credential', () => {
  const ISSUER_SECRET = Buffer.from('issuer-secret-000000000000000000', 'utf8')
  const HOLDER_SECRET = Buffer.from('holder-secret-000000000000000000', 'utf8')
  const ATTRIBUTES    = Buffer.from('age>=18,country=US', 'utf8')
  const ISSUED_AT     = 1_700_000_000n
  const NONCE_1       = Buffer.alloc(32).fill(0x01)
  const NONCE_2       = Buffer.alloc(32).fill(0x02)

  it('issue + present + verify roundtrip succeeds', () => {
    const cred = issueCredential(ISSUER_SECRET, ATTRIBUTES, ISSUED_AT)
    expect(cred.credentialId.length).toBe(32)

    const pres = present(cred, HOLDER_SECRET, NONCE_1)
    expect(pres.pseudonym.length).toBe(32)
    expect(pres.proof.length).toBe(32)

    expect(verifyPresentation(cred, HOLDER_SECRET, pres)).toBe(true)
  })

  it('two presentations with different nonces produce different pseudonyms (unlinkable)', () => {
    const cred  = issueCredential(ISSUER_SECRET, ATTRIBUTES, ISSUED_AT)
    const pres1 = present(cred, HOLDER_SECRET, NONCE_1)
    const pres2 = present(cred, HOLDER_SECRET, NONCE_2)

    expect(pres1.pseudonym.equals(pres2.pseudonym)).toBe(false)
    expect(pres1.proof.equals(pres2.proof)).toBe(false)
  })

  it('zero nonce is rejected at presentation time', () => {
    const cred      = issueCredential(ISSUER_SECRET, ATTRIBUTES, ISSUED_AT)
    const zeroNonce = Buffer.alloc(32)
    expect(() => present(cred, HOLDER_SECRET, zeroNonce)).toThrow('zero nonce rejected')
  })

  it('empty attribute bytes are rejected at issuance', () => {
    expect(() => issueCredential(ISSUER_SECRET, Buffer.alloc(0), ISSUED_AT))
      .toThrow('attribute empty rejected')
  })

  it('verify_presentation returns false for tampered proof', () => {
    const cred = issueCredential(ISSUER_SECRET, ATTRIBUTES, ISSUED_AT)
    const pres = present(cred, HOLDER_SECRET, NONCE_1)

    // Tamper the proof
    const tamperedPres: Presentation = {
      ...pres,
      proof: Buffer.alloc(32).fill(0xff),
    }
    expect(verifyPresentation(cred, HOLDER_SECRET, tamperedPres)).toBe(false)

    // Tamper pseudonym
    const tamperedPres2: Presentation = {
      ...pres,
      pseudonym: Buffer.alloc(32).fill(0xee),
    }
    expect(verifyPresentation(cred, HOLDER_SECRET, tamperedPres2)).toBe(false)
  })

  it('public record hides issuer_hash, and mainnet_ready is false', () => {
    const cred = issueCredential(ISSUER_SECRET, ATTRIBUTES, ISSUED_AT)
    const pres = present(cred, HOLDER_SECRET, NONCE_1)
    const rec  = publicRecord(cred, pres) as Record<string, unknown>

    // Issuer hash must be null/hidden
    expect(rec['issuer_hash']).toBeNull()
    // Credential ID and pseudonym are present (for auditability)
    expect(typeof rec['credential_id']).toBe('string')
    expect((rec['credential_id'] as string).length).toBe(64)
    expect(rec['mainnet_ready']).toBe(false)

    // Make sure the actual issuer hash value is not in the serialised record
    const iHash = issuerHash(ISSUER_SECRET).toString('hex')
    expect(JSON.stringify(rec)).not.toContain(iHash)
  })
})
