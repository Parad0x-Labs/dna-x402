/**
 * Blind oracle attestation tests — TypeScript mirror of
 * crates/dark-blind-oracle/src/lib.rs
 *
 * Algorithms (all SHA256-based, pure Node.js crypto):
 *   data_hash          = SHA256("blind-data-v1" || data)
 *   blinded_commitment = SHA256("blind-req-v1"  || data_hash || blinding_factor)
 *   oracle_pubkey      = SHA256("oracle-pub-v1" || oracle_secret)
 *   oracle_sig         = SHA256("oracle-sign-v1" || oracle_pubkey || blinded_commitment)
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Core primitive
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Protocol helpers (mirrors Rust internal functions)
// ---------------------------------------------------------------------------

function dataHash(data: Buffer): Buffer {
  return sha256(Buffer.from('blind-data-v1'), data)
}

function blindedCommitment(dh: Buffer, blindingFactor: Buffer): Buffer {
  return sha256(Buffer.from('blind-req-v1'), dh, blindingFactor)
}

function oraclePubkey(oracleSecret: Buffer): Buffer {
  return sha256(Buffer.from('oracle-pub-v1'), oracleSecret)
}

function oracleSig(pubkey: Buffer, commitment: Buffer): Buffer {
  return sha256(Buffer.from('oracle-sign-v1'), pubkey, commitment)
}

// ---------------------------------------------------------------------------
// Public API (matches Rust public API surface)
// ---------------------------------------------------------------------------

function blindData(data: Buffer, blindingFactor: Buffer): Buffer {
  const dh = dataHash(data)
  return blindedCommitment(dh, blindingFactor)
}

interface OracleAttestation {
  blindedCommitmentHex: string
  oraclePubkeyHex: string
  oracleSigHex: string
  attestedAt: number
}

function oracleAttest(
  oracleSecret: Buffer,
  commitment: Buffer,
  attestedAt: number,
): OracleAttestation {
  const pubkey = oraclePubkey(oracleSecret)
  const sig = oracleSig(pubkey, commitment)
  return {
    blindedCommitmentHex: commitment.toString('hex'),
    oraclePubkeyHex: pubkey.toString('hex'),
    oracleSigHex: sig.toString('hex'),
    attestedAt,
  }
}

/**
 * Unblind: recompute blinded_commitment from data + blindingFactor,
 * verify it matches the attestation, then return the data_hash.
 *
 * Returns null on mismatch (mirrors Rust OracleError::AttestationMismatch).
 */
function unblindAttestation(
  attestation: OracleAttestation,
  data: Buffer,
  blindingFactor: Buffer,
): { dataHashHex: string; oracleSigHex: string; oraclePubkeyHex: string } | null {
  const dh = dataHash(data)
  const recomputed = blindedCommitment(dh, blindingFactor)
  if (recomputed.toString('hex') !== attestation.blindedCommitmentHex) {
    return null
  }
  return {
    dataHashHex: dh.toString('hex'),
    oracleSigHex: attestation.oracleSigHex,
    oraclePubkeyHex: attestation.oraclePubkeyHex,
  }
}

function attestationPublicRecord(attestation: OracleAttestation): object {
  return {
    oracle_pubkey_hex: attestation.oraclePubkeyHex,
    oracle_sig_hex: attestation.oracleSigHex,
    attested_at: attestation.attestedAt,
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORACLE_SECRET = Buffer.alloc(32, 0xde)
ORACLE_SECRET[0] = 0xde
ORACLE_SECRET[1] = 0xad
ORACLE_SECRET[31] = 0x01

const BLINDING_FACTOR = Buffer.alloc(32, 0x00)
BLINDING_FACTOR[0] = 0xca
BLINDING_FACTOR[1] = 0xfe
BLINDING_FACTOR[31] = 0x42

const ATTESTED_AT = 1_700_000_000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null blind oracle attestation', () => {
  it('happy path: blind, attest, unblind roundtrip', () => {
    const data = Buffer.from('oracle please attest this')
    const commitment = blindData(data, BLINDING_FACTOR)
    const attestation = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)

    // The stored blinded_commitment must match what we computed
    expect(attestation.blindedCommitmentHex).toBe(commitment.toString('hex'))

    const unblinded = unblindAttestation(attestation, data, BLINDING_FACTOR)
    expect(unblinded).not.toBeNull()

    // oracle_sig and oracle_pubkey must flow through unchanged
    expect(unblinded!.oracleSigHex).toBe(attestation.oracleSigHex)
    expect(unblinded!.oraclePubkeyHex).toBe(attestation.oraclePubkeyHex)

    // data_hash must equal SHA256("blind-data-v1" || data)
    const expectedDataHash = sha256(Buffer.from('blind-data-v1'), data).toString('hex')
    expect(unblinded!.dataHashHex).toBe(expectedDataHash)
  })

  it('wrong blinding factor fails unblind', () => {
    const data = Buffer.from('some secret data')
    const commitment = blindData(data, BLINDING_FACTOR)
    const attestation = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)

    // Flip a byte to produce a different blinding factor
    const wrongBlinding = Buffer.from(BLINDING_FACTOR)
    wrongBlinding[0] ^= 0xff

    // Different blinding factor → different blinded_commitment → mismatch
    const result = unblindAttestation(attestation, data, wrongBlinding)
    expect(result).toBeNull()
  })

  it('wrong data fails unblind', () => {
    const data = Buffer.from('original data')
    const tamperedData = Buffer.from('tampered data')
    const commitment = blindData(data, BLINDING_FACTOR)
    const attestation = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)

    // Different data → different data_hash → different blinded_commitment → mismatch
    const result = unblindAttestation(attestation, tamperedData, BLINDING_FACTOR)
    expect(result).toBeNull()
  })

  it('oracle_sig is deterministic', () => {
    const data = Buffer.from('determinism test payload')
    const commitment = blindData(data, BLINDING_FACTOR)

    const att1 = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)
    const att2 = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)

    // Same oracle_secret + same blinded_commitment → identical sig
    expect(att1.oracleSigHex).toBe(att2.oracleSigHex)
    expect(att1.oraclePubkeyHex).toBe(att2.oraclePubkeyHex)
  })

  it('different oracles produce different sigs', () => {
    const data = Buffer.from('same data, different oracles')
    const commitment = blindData(data, BLINDING_FACTOR)

    const secretA = Buffer.from(ORACLE_SECRET)
    const secretB = Buffer.alloc(32, 0x99) // completely different oracle secret

    const attA = oracleAttest(secretA, commitment, ATTESTED_AT)
    const attB = oracleAttest(secretB, commitment, ATTESTED_AT)

    // Different oracle secrets → different pubkeys → different sigs
    expect(attA.oraclePubkeyHex).not.toBe(attB.oraclePubkeyHex)
    expect(attA.oracleSigHex).not.toBe(attB.oracleSigHex)
  })

  it('public record shape', () => {
    const data = Buffer.from('super secret payload')
    const commitment = blindData(data, BLINDING_FACTOR)
    const attestation = oracleAttest(ORACLE_SECRET, commitment, ATTESTED_AT)

    const record = attestationPublicRecord(attestation) as Record<string, unknown>

    // Required public fields
    expect(typeof record.oracle_pubkey_hex).toBe('string')
    expect((record.oracle_pubkey_hex as string).length).toBe(64) // 32 bytes hex
    expect(typeof record.oracle_sig_hex).toBe('string')
    expect((record.oracle_sig_hex as string).length).toBe(64)
    expect(typeof record.attested_at).toBe('number')

    // Must NOT leak raw data, blinding factor, or commitment
    const json = JSON.stringify(record)
    expect(json).not.toContain('super secret payload')
    expect(json).not.toContain(BLINDING_FACTOR.toString('hex'))
    expect(json).not.toContain('blinded_commitment')
  })
})
