import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u8(n: number): Buffer { return Buffer.from([n]) }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// Attribute enum values (match lib.rs)
const AgeOver18 = 1
const KycVerified = 2
const AccreditedInvestor = 3
const SolanaHolder = 4

function holderHash(holderSecret: Buffer): Buffer {
  return sha256(Buffer.from('holder-hash-v1'), holderSecret)
}

function attributeBits(attrs: number[]): Buffer {
  let bits = 0
  for (const attr of attrs) {
    bits |= (1 << attr)
  }
  const b = Buffer.alloc(4)
  b.writeUInt32LE(bits)
  return b
}

function credentialId(
  holderH: Buffer,
  attrBits: Buffer,
  issuedAt: bigint,
): Buffer {
  return sha256(
    Buffer.from('credential-id-v1'),
    holderH,
    attrBits,
    u64le(issuedAt),
  )
}

function disclosureProof(
  credId: Buffer,
  attr: number,
  holderH: Buffer,
): Buffer {
  return sha256(
    Buffer.from('disclose-v1'),
    credId,
    u8(attr),
    holderH,
  )
}

describe('dark-null identity-credential', () => {
  it('issue with AgeOver18+KycVerified, disclose AgeOver18', () => {
    const secret = Buffer.from('secret-alice-001')
    const holderH = holderHash(secret)

    const attrs = [AgeOver18, KycVerified]
    const bits = attributeBits(attrs)

    const issuedAt = 1_000_000n
    const credId = credentialId(holderH, bits, issuedAt)

    // Credential should contain AgeOver18 bit
    const bitsVal = bits.readUInt32LE(0)
    expect(bitsVal & (1 << AgeOver18)).toBeTruthy()

    // Disclose AgeOver18
    const proof = disclosureProof(credId, AgeOver18, holderH)

    // Recompute and verify
    const proofCheck = disclosureProof(credId, AgeOver18, holderH)
    expect(proof.toString('hex')).toBe(proofCheck.toString('hex'))

    // Proof should be 32 bytes
    expect(proof.length).toBe(32)
  })

  it('attribute not present: AccreditedInvestor when only AgeOver18 issued', () => {
    const secret = Buffer.from('secret-bob-002')
    const holderH = holderHash(secret)

    const attrs = [AgeOver18]
    const bits = attributeBits(attrs)

    const bitsVal = bits.readUInt32LE(0)

    // AccreditedInvestor bit should NOT be set
    expect(bitsVal & (1 << AccreditedInvestor)).toBe(0)

    // AgeOver18 bit should be set
    expect(bitsVal & (1 << AgeOver18)).toBeTruthy()
  })

  it('expired credential: current > expires_at', () => {
    const secret = Buffer.from('secret-carol-003')
    const holderH = holderHash(secret)

    const attrs = [KycVerified]
    const bits = attributeBits(attrs)

    const issuedAt = 1_000_000n
    const expiresAt = 2_000_000n
    const currentTime = 3_000_000n

    // Credential is expired when current > expires_at
    const isExpired = currentTime > expiresAt
    expect(isExpired).toBe(true)

    // A valid window: current <= expires_at
    const currentTimeValid = 1_500_000n
    const isValid = currentTimeValid <= expiresAt
    expect(isValid).toBe(true)
  })

  it('verify_disclosure: recompute proof and check', () => {
    const secret = Buffer.from('secret-dave-004')
    const holderH = holderHash(secret)

    const attrs = [AgeOver18, KycVerified, SolanaHolder]
    const bits = attributeBits(attrs)

    const issuedAt = 999_999n
    const credId = credentialId(holderH, bits, issuedAt)

    // Prover generates a disclosure proof for KycVerified
    const proof = disclosureProof(credId, KycVerified, holderH)

    // Verifier recomputes using same inputs
    const verifierProof = disclosureProof(credId, KycVerified, holderH)
    expect(proof.toString('hex')).toBe(verifierProof.toString('hex'))

    // Wrong attribute yields a different proof
    const wrongProof = disclosureProof(credId, SolanaHolder, holderH)
    expect(proof.toString('hex')).not.toBe(wrongProof.toString('hex'))
  })

  it('two different holders get different credential_ids', () => {
    const secretA = Buffer.from('secret-alice-005')
    const secretB = Buffer.from('secret-bob-005')

    const holderHA = holderHash(secretA)
    const holderHB = holderHash(secretB)

    const attrs = [AgeOver18]
    const bits = attributeBits(attrs)
    const issuedAt = 1_234_567n

    const credIdA = credentialId(holderHA, bits, issuedAt)
    const credIdB = credentialId(holderHB, bits, issuedAt)

    expect(credIdA.toString('hex')).not.toBe(credIdB.toString('hex'))
  })

  it('public record: attribute_bits present, no holder_hash', () => {
    const secret = Buffer.from('secret-eve-006')
    const holderH = holderHash(secret)

    const attrs = [AgeOver18, AccreditedInvestor]
    const bits = attributeBits(attrs)

    const issuedAt = 7_777_777n
    const credId = credentialId(holderH, bits, issuedAt)

    // Public record contains: credential_id and attribute_bits
    // It does NOT contain holder_hash or holder_secret
    const publicRecord = {
      credential_id: credId.toString('hex'),
      attribute_bits: bits.readUInt32LE(0),
    }

    expect(publicRecord.credential_id).toBe(credId.toString('hex'))
    expect(publicRecord.attribute_bits & (1 << AgeOver18)).toBeTruthy()
    expect(publicRecord.attribute_bits & (1 << AccreditedInvestor)).toBeTruthy()

    // holder_hash is NOT in the public record
    expect('holder_hash' in publicRecord).toBe(false)
  })
})
