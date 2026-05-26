import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Crypto primitives (mirrors dark-agent-escrow/src/lib.rs)
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

/** little-endian u64 */
function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

/** little-endian i64 */
function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

function hexEncode(buf: Buffer): string {
  return buf.toString('hex')
}

// ---------------------------------------------------------------------------
// Agent escrow primitives (TypeScript mirror of dark-agent-escrow/src/lib.rs)
//
// Hash construction (domain tags match the Rust source exactly):
//   payer_hash      = SHA256("escrow-payer-v1"     || payer_secret)
//   condition_hash  = SHA256("escrow-condition-v1" || condition_bytes)
//   escrow_id       = SHA256("escrow-id-v1" || payer_hash || amount_le
//                            || condition_hash || created_at_le)
//   beneficiary_hash = SHA256("beneficiary-hash-v1" || beneficiary_secret)
//   release_proof    = SHA256("escrow-release-v1"  || escrow_id
//                             || beneficiary_hash || condition_bytes)
// ---------------------------------------------------------------------------

function computePayerHash(payerSecret: Buffer): Buffer {
  return sha256(Buffer.from('escrow-payer-v1'), payerSecret)
}

function computeConditionHash(conditionBytes: Buffer): Buffer {
  return sha256(Buffer.from('escrow-condition-v1'), conditionBytes)
}

function computeEscrowId(
  payerHash: Buffer,
  amount: bigint,
  conditionHash: Buffer,
  createdAtUnix: bigint,
): Buffer {
  return sha256(
    Buffer.from('escrow-id-v1'),
    payerHash,
    u64le(amount),
    conditionHash,
    i64le(createdAtUnix),
  )
}

function computeBeneficiaryHash(beneficiarySecret: Buffer): Buffer {
  return sha256(Buffer.from('beneficiary-hash-v1'), beneficiarySecret)
}

function computeReleaseProof(
  escrowId: Buffer,
  beneficiaryHash: Buffer,
  conditionBytes: Buffer,
): Buffer {
  return sha256(
    Buffer.from('escrow-release-v1'),
    escrowId,
    beneficiaryHash,
    conditionBytes,
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EscrowDeposit {
  escrow_id: Buffer
  payer_hash: Buffer
  condition_hash: Buffer
  amount: bigint
  created_at_unix: bigint
  expires_at_unix: bigint
  resolved: boolean
}

interface EscrowRelease {
  escrow_id: Buffer
  beneficiary_hash: Buffer
  release_proof: Buffer
  amount: bigint
  released_at_unix: bigint
}

type EscrowError =
  | 'ZeroAmount'
  | 'AlreadyResolved'
  | `Expired:${string}`
  | 'ConditionMismatch'
  | 'PayerSecretZero'

function createEscrow(
  payerSecret: Buffer,
  amount: bigint,
  conditionBytes: Buffer,
  createdAtUnix: bigint,
  expiresAtUnix: bigint,
): { ok: EscrowDeposit } | { err: EscrowError } {
  if (amount === 0n) return { err: 'ZeroAmount' }
  if (payerSecret.equals(Buffer.alloc(32, 0))) return { err: 'PayerSecretZero' }

  const payerHash = computePayerHash(payerSecret)
  const conditionHash = computeConditionHash(conditionBytes)
  const escrowId = computeEscrowId(payerHash, amount, conditionHash, createdAtUnix)

  return {
    ok: {
      escrow_id: escrowId,
      payer_hash: payerHash,
      condition_hash: conditionHash,
      amount,
      created_at_unix: createdAtUnix,
      expires_at_unix: expiresAtUnix,
      resolved: false,
    },
  }
}

function releaseEscrow(
  escrow: EscrowDeposit,
  beneficiarySecret: Buffer,
  conditionBytes: Buffer,
  currentUnix: bigint,
): { ok: EscrowRelease; updatedEscrow: EscrowDeposit } | { err: EscrowError } {
  if (escrow.resolved) return { err: 'AlreadyResolved' }
  if (currentUnix > escrow.expires_at_unix) {
    return { err: `Expired:expired_at=${escrow.expires_at_unix},current=${currentUnix}` }
  }

  const recomputedCondition = computeConditionHash(conditionBytes)
  if (!recomputedCondition.equals(escrow.condition_hash)) {
    return { err: 'ConditionMismatch' }
  }

  const beneficiaryHash = computeBeneficiaryHash(beneficiarySecret)
  const releaseProof = computeReleaseProof(escrow.escrow_id, beneficiaryHash, conditionBytes)

  const updatedEscrow: EscrowDeposit = { ...escrow, resolved: true }

  return {
    ok: {
      escrow_id: escrow.escrow_id,
      beneficiary_hash: beneficiaryHash,
      release_proof: releaseProof,
      amount: escrow.amount,
      released_at_unix: currentUnix,
    },
    updatedEscrow,
  }
}

/** Public record — mirrors escrow_public_record() in Rust. Does NOT include payer_hash or amount. */
function escrowPublicRecord(escrow: EscrowDeposit): Record<string, unknown> {
  return {
    escrow_id_hex: hexEncode(escrow.escrow_id),
    condition_hash_hex: hexEncode(escrow.condition_hash),
    created_at_unix: escrow.created_at_unix.toString(),
    expires_at_unix: escrow.expires_at_unix.toString(),
    resolved: escrow.resolved,
    // payer_hash and amount intentionally excluded
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function payerSecret(): Buffer {
  const s = Buffer.alloc(32, 0)
  s[0] = 0xde
  s[1] = 0xad
  return s
}

function beneficiarySecret(): Buffer {
  const s = Buffer.alloc(32, 0)
  s[0] = 0xbe
  s[1] = 0xef
  return s
}

const CONDITION = Buffer.from('deliver-service-xyz')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null agent escrow', () => {
  it('happy path: create escrow and release', () => {
    const createdAt = 1_700_000_000n
    const expiresAt = 1_700_086_400n // +1 day
    const currentTime = 1_700_043_200n // mid-window

    const createResult = createEscrow(payerSecret(), 1_000_000n, CONDITION, createdAt, expiresAt)
    expect('ok' in createResult).toBe(true)

    const escrow = (createResult as { ok: EscrowDeposit }).ok
    expect(escrow.resolved).toBe(false)
    expect(escrow.amount).toBe(1_000_000n)
    expect(escrow.escrow_id.length).toBe(32)
    expect(escrow.condition_hash.length).toBe(32)
    expect(escrow.escrow_id.equals(Buffer.alloc(32, 0))).toBe(false)

    const releaseResult = releaseEscrow(escrow, beneficiarySecret(), CONDITION, currentTime)
    expect('ok' in releaseResult).toBe(true)

    const { ok: release, updatedEscrow } = releaseResult as { ok: EscrowRelease; updatedEscrow: EscrowDeposit }
    expect(updatedEscrow.resolved).toBe(true)
    expect(release.amount).toBe(1_000_000n)
    expect(release.escrow_id.equals(escrow.escrow_id)).toBe(true)
    expect(release.released_at_unix).toBe(currentTime)
    expect(release.release_proof.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(release.beneficiary_hash.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('double release rejected — simulate resolved=true flag, second release detected', () => {
    const createResult = createEscrow(
      payerSecret(), 500n, CONDITION, 1_000_000_000n, 2_000_000_000n,
    )
    expect('ok' in createResult).toBe(true)
    const escrow = (createResult as { ok: EscrowDeposit }).ok

    const first = releaseEscrow(escrow, beneficiarySecret(), CONDITION, 1_500_000_000n)
    expect('ok' in first).toBe(true)
    const { updatedEscrow: resolved } = first as { ok: EscrowRelease; updatedEscrow: EscrowDeposit }

    // Second release attempt on the now-resolved escrow
    const second = releaseEscrow(resolved, beneficiarySecret(), CONDITION, 1_500_000_001n)
    expect('err' in second).toBe(true)
    expect((second as { err: string }).err).toBe('AlreadyResolved')
  })

  it('expired escrow rejected — current_unix > expires_at_unix', () => {
    const expiresAt = 1_700_000_000n
    const currentTime = 1_700_000_001n // one second past expiry

    const createResult = createEscrow(
      payerSecret(), 999n, CONDITION, 1_699_000_000n, expiresAt,
    )
    expect('ok' in createResult).toBe(true)
    const escrow = (createResult as { ok: EscrowDeposit }).ok

    const result = releaseEscrow(escrow, beneficiarySecret(), CONDITION, currentTime)
    expect('err' in result).toBe(true)
    expect((result as { err: string }).err).toContain('Expired')
    // Verify expiry details are present in the error
    expect((result as { err: string }).err).toContain(expiresAt.toString())
    expect((result as { err: string }).err).toContain(currentTime.toString())
  })

  it('wrong condition rejected — different condition_bytes → different condition_hash → mismatch', () => {
    const createResult = createEscrow(
      payerSecret(), 100n, CONDITION, 1_000_000_000n, 9_999_999_999n,
    )
    expect('ok' in createResult).toBe(true)
    const escrow = (createResult as { ok: EscrowDeposit }).ok

    const wrongCondition = Buffer.from('wrong-condition')

    // Sanity: wrong condition produces a different condition_hash
    const correctHash = computeConditionHash(CONDITION)
    const wrongHash = computeConditionHash(wrongCondition)
    expect(correctHash.equals(wrongHash)).toBe(false)

    const result = releaseEscrow(escrow, beneficiarySecret(), wrongCondition, 1_000_000_001n)
    expect('err' in result).toBe(true)
    expect((result as { err: string }).err).toBe('ConditionMismatch')
  })

  it('escrow_id is deterministic — same inputs always produce same escrow_id', () => {
    const amount = 12_345n
    const createdAt = 1_700_000_000n
    const expiresAt = 1_800_000_000n

    const r1 = createEscrow(payerSecret(), amount, CONDITION, createdAt, expiresAt)
    const r2 = createEscrow(payerSecret(), amount, CONDITION, createdAt, expiresAt)
    const r3 = createEscrow(payerSecret(), amount, CONDITION, createdAt, expiresAt)

    expect('ok' in r1 && 'ok' in r2 && 'ok' in r3).toBe(true)
    const id1 = (r1 as { ok: EscrowDeposit }).ok.escrow_id
    const id2 = (r2 as { ok: EscrowDeposit }).ok.escrow_id
    const id3 = (r3 as { ok: EscrowDeposit }).ok.escrow_id

    expect(id1.equals(id2)).toBe(true)
    expect(id1.equals(id3)).toBe(true)

    // Different created_at → different escrow_id
    const rOther = createEscrow(payerSecret(), amount, CONDITION, createdAt + 1n, expiresAt)
    const idOther = (rOther as { ok: EscrowDeposit }).ok.escrow_id
    expect(id1.equals(idOther)).toBe(false)
  })

  it('public record shape — has escrow_id_hex, condition_hash_hex, timestamps, resolved; no payer_hash, no amount', () => {
    const createResult = createEscrow(
      payerSecret(), 42_000_000n, CONDITION, 1_000_000_000n, 2_000_000_000n,
    )
    expect('ok' in createResult).toBe(true)
    const escrow = (createResult as { ok: EscrowDeposit }).ok

    const record = escrowPublicRecord(escrow)
    const recordJson = JSON.stringify(record)

    // Required public fields
    expect(typeof record.escrow_id_hex).toBe('string')
    expect(typeof record.condition_hash_hex).toBe('string')
    expect(record.created_at_unix).toBeDefined()
    expect(record.expires_at_unix).toBeDefined()
    expect(record.resolved).toBe(false)

    // escrow_id_hex and condition_hash_hex should be 64-char hex strings
    expect((record.escrow_id_hex as string).length).toBe(64)
    expect((record.condition_hash_hex as string).length).toBe(64)

    // payer_hash must NOT appear in the record
    const payerHashHex = hexEncode(escrow.payer_hash)
    expect(recordJson).not.toContain(payerHashHex)
    expect(Object.keys(record)).not.toContain('payer_hash')

    // amount must NOT appear in the record
    expect(recordJson).not.toContain('42000000')
    expect(Object.keys(record)).not.toContain('amount')
  })
})
