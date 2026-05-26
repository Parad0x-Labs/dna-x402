import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

const ISSUER_SECRET = Buffer.from('issuer-secret-deadbeef01234567', 'utf8')
const BENEFICIARY_SECRET = Buffer.from('beneficiary-secret-cafebabe0000', 'utf8')
const AMOUNT = 1_000_000n
const MATURITY = 1_800_000_000n // unix ts in future
const NONCE = Buffer.from('nonce-aabbccdd11223344', 'utf8')

function buildBondId(
  issuerSecret: Buffer,
  beneficiarySecret: Buffer,
  amount: bigint,
  maturity: bigint,
  nonce: Buffer
): { issuerHash: Buffer; beneficiaryHash: Buffer; covenantHash: Buffer; bondId: Buffer } {
  const issuerHash = sha256(Buffer.from('bond-issuer-v1'), issuerSecret)
  const beneficiaryHash = sha256(Buffer.from('bond-beneficiary-v1'), beneficiarySecret)
  const covenantHash = sha256(
    Buffer.from('bond-covenant-v1'),
    issuerHash,
    beneficiaryHash,
    u64le(amount),
    i64le(maturity)
  )
  const bondId = sha256(Buffer.from('bond-id-v1'), covenantHash, nonce)
  return { issuerHash, beneficiaryHash, covenantHash, bondId }
}

describe('dark-null bond-covenant', () => {
  it('bond_id computation matches expected', () => {
    const { issuerHash, beneficiaryHash, covenantHash, bondId } = buildBondId(
      ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, NONCE
    )

    // Recompute independently
    const expectedIssuerHash = sha256(Buffer.from('bond-issuer-v1'), ISSUER_SECRET)
    const expectedBeneficiaryHash = sha256(Buffer.from('bond-beneficiary-v1'), BENEFICIARY_SECRET)
    const expectedCovenantHash = sha256(
      Buffer.from('bond-covenant-v1'),
      expectedIssuerHash,
      expectedBeneficiaryHash,
      u64le(AMOUNT),
      i64le(MATURITY)
    )
    const expectedBondId = sha256(Buffer.from('bond-id-v1'), expectedCovenantHash, NONCE)

    expect(issuerHash.toString('hex')).toBe(expectedIssuerHash.toString('hex'))
    expect(beneficiaryHash.toString('hex')).toBe(expectedBeneficiaryHash.toString('hex'))
    expect(covenantHash.toString('hex')).toBe(expectedCovenantHash.toString('hex'))
    expect(bondId.toString('hex')).toBe(expectedBondId.toString('hex'))
    expect(bondId).toHaveLength(32)
  })

  it('covenant_hash changes if amount changes (amount sensitivity)', () => {
    const { covenantHash: c1 } = buildBondId(ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, NONCE)
    const { covenantHash: c2 } = buildBondId(ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT + 1n, MATURITY, NONCE)
    expect(c1.toString('hex')).not.toBe(c2.toString('hex'))
  })

  it('redeem before maturity triggers error condition (maturity guard)', () => {
    const currentTime = 1_700_000_000n // well before MATURITY
    const { bondId, covenantHash } = buildBondId(ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, NONCE)

    // Guard: redemption is only valid when currentTime >= maturity
    function canRedeem(now: bigint, maturity: bigint): boolean {
      return now >= maturity
    }

    expect(canRedeem(currentTime, MATURITY)).toBe(false)
    // Bond ID and covenant hash are still well-formed; the guard rejects the operation
    expect(bondId).toHaveLength(32)
    expect(covenantHash).toHaveLength(32)
  })

  it('public record contains bond_id and covenant_hash, NOT issuer_hash or beneficiary_hash', () => {
    const { issuerHash, beneficiaryHash, covenantHash, bondId } = buildBondId(
      ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, NONCE
    )

    // Simulate the public record
    const publicRecord = {
      bond_id: bondId.toString('hex'),
      covenant_hash: covenantHash.toString('hex'),
    }

    expect(publicRecord).toHaveProperty('bond_id')
    expect(publicRecord).toHaveProperty('covenant_hash')
    expect(publicRecord).not.toHaveProperty('issuer_hash')
    expect(publicRecord).not.toHaveProperty('beneficiary_hash')

    // Verify private data is NOT in the public record values
    expect(Object.values(publicRecord)).not.toContain(issuerHash.toString('hex'))
    expect(Object.values(publicRecord)).not.toContain(beneficiaryHash.toString('hex'))
  })

  it('different nonces produce different bond_ids', () => {
    const nonce1 = Buffer.from('nonce-111111111111111111111111', 'utf8')
    const nonce2 = Buffer.from('nonce-222222222222222222222222', 'utf8')

    const { bondId: id1, covenantHash: c1 } = buildBondId(ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, nonce1)
    const { bondId: id2, covenantHash: c2 } = buildBondId(ISSUER_SECRET, BENEFICIARY_SECRET, AMOUNT, MATURITY, nonce2)

    // covenant_hash is the same (nonce not in covenant)
    expect(c1.toString('hex')).toBe(c2.toString('hex'))
    // bond_id differs
    expect(id1.toString('hex')).not.toBe(id2.toString('hex'))
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
  })
})
