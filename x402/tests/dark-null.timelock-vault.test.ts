import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Pure-Node implementation of the time-locked vault scheme
// Mirrors: crates/dark-timelock-vault/src/lib.rs
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

function amountLE(amount: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(amount)
  return buf
}

function unixLE(ts: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(ts)
  return buf
}

// vault_id = SHA256("vault-deposit-v1" || amount_le || secret || deposited_at_le)
function vaultId(amount: bigint, secret: Buffer, depositedAt: bigint): Buffer {
  return sha256(
    Buffer.from('vault-deposit-v1'),
    amountLE(amount),
    secret,
    unixLE(depositedAt),
  )
}

// amount_commitment = SHA256("vault-commit-v1" || amount_le || secret)
function amountCommitment(amount: bigint, secret: Buffer): Buffer {
  return sha256(Buffer.from('vault-commit-v1'), amountLE(amount), secret)
}

// withdrawal_proof = SHA256("vault-withdraw-v1" || vault_id || amount_le || current_unix_le)
function withdrawalProof(vaultIdBuf: Buffer, amount: bigint, currentUnix: bigint): Buffer {
  return sha256(
    Buffer.from('vault-withdraw-v1'),
    vaultIdBuf,
    amountLE(amount),
    unixLE(currentUnix),
  )
}

// ---------------------------------------------------------------------------
// Vault lifecycle helpers
// ---------------------------------------------------------------------------

interface VaultDeposit {
  vaultId: Buffer
  amountCommitment: Buffer
  lockUntil: bigint
  depositedAt: bigint
}

function deposit(
  amount: bigint,
  secret: Buffer,
  depositedAt: bigint,
  lockUntil: bigint,
): VaultDeposit {
  return {
    vaultId: vaultId(amount, secret, depositedAt),
    amountCommitment: amountCommitment(amount, secret),
    lockUntil,
    depositedAt,
  }
}

type WithdrawResult =
  | { ok: true; proof: Buffer }
  | { ok: false; error: 'TOO_EARLY' | 'COMMITMENT_MISMATCH' }

function withdraw(
  vault: VaultDeposit,
  amount: bigint,
  secret: Buffer,
  currentUnix: bigint,
): WithdrawResult {
  if (currentUnix < vault.lockUntil) {
    return { ok: false, error: 'TOO_EARLY' }
  }
  const provided = amountCommitment(amount, secret)
  if (!provided.equals(vault.amountCommitment)) {
    return { ok: false, error: 'COMMITMENT_MISMATCH' }
  }
  return {
    ok: true,
    proof: withdrawalProof(vault.vaultId, amount, currentUnix),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null timelock vault', () => {
  it('happy path: deposit and withdraw at exact lock_until time', () => {
    const amount = 1_000_000_000n
    const secret = Buffer.from('vault-secret-alice-v1')
    const depositedAt = 1_700_000_000n
    const lockUntil = 1_700_000_000n + 86_400n // +1 day

    const vault = deposit(amount, secret, depositedAt, lockUntil)

    // Attempt at exactly lockUntil should succeed
    const result = withdraw(vault, amount, secret, lockUntil)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proof).toHaveLength(32)
    }
  })

  it('too early: withdrawal rejected before unlock time', () => {
    const amount = 500_000_000n
    const secret = Buffer.from('vault-secret-bob-v1')
    const depositedAt = 1_700_000_000n
    const lockUntil = 1_700_000_000n + 86_400n

    const vault = deposit(amount, secret, depositedAt, lockUntil)

    // One second before unlock
    const tooEarly = lockUntil - 1n
    const result = withdraw(vault, amount, secret, tooEarly)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('TOO_EARLY')
    }
  })

  it('wrong secret: commitment mismatch when secret differs', () => {
    const amount = 250_000_000n
    const secret = Buffer.from('vault-secret-carol-v1')
    const wrongSecret = Buffer.from('vault-secret-imposter')
    const depositedAt = 1_700_000_000n
    const lockUntil = 1_700_000_000n + 3_600n

    const vault = deposit(amount, secret, depositedAt, lockUntil)

    // Attempt with wrong secret after unlock time
    const result = withdraw(vault, amount, wrongSecret, lockUntil + 1n)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('COMMITMENT_MISMATCH')
    }

    // The correct secret still works
    const correct = withdraw(vault, amount, secret, lockUntil + 1n)
    expect(correct.ok).toBe(true)
  })

  it('vault_id is deterministic: same inputs always produce same vault_id', () => {
    const amount = 2_000_000_000n
    const secret = Buffer.from('determinism-test-secret')
    const depositedAt = 1_750_000_000n

    const id1 = vaultId(amount, secret, depositedAt)
    const id2 = vaultId(amount, secret, depositedAt)
    const id3 = vaultId(amount, secret, depositedAt)

    expect(id1.equals(id2)).toBe(true)
    expect(id2.equals(id3)).toBe(true)
    expect(id1).toHaveLength(32)
  })

  it('withdrawal_proof binds to vault_id and time: different current_unix → different proof', () => {
    const amount = 1_500_000_000n
    const secret = Buffer.from('vault-secret-dave-v1')
    const depositedAt = 1_700_000_000n
    const lockUntil = depositedAt + 3_600n

    const vault = deposit(amount, secret, depositedAt, lockUntil)

    const r1 = withdraw(vault, amount, secret, lockUntil)
    const r2 = withdraw(vault, amount, secret, lockUntil + 60n)

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    if (r1.ok && r2.ok) {
      // Different timestamps → different proofs
      expect(r1.proof.equals(r2.proof)).toBe(false)
    }
  })

  it('public record shape: JSON has vault_id_hex, lock_until, deposited_at; no amount', () => {
    const amount = 750_000_000n
    const secret = Buffer.from('vault-secret-eve-v1')
    const depositedAt = 1_700_500_000n
    const lockUntil = depositedAt + 7_200n

    const vault = deposit(amount, secret, depositedAt, lockUntil)

    // Public record: observable on-chain without leaking amount
    const publicRecord = {
      vault_id_hex: vault.vaultId.toString('hex'),
      lock_until: Number(vault.lockUntil),
      deposited_at: Number(vault.depositedAt),
    }

    const json = JSON.stringify(publicRecord)
    const parsed = JSON.parse(json) as Record<string, unknown>

    // Required fields
    expect(typeof parsed['vault_id_hex']).toBe('string')
    expect((parsed['vault_id_hex'] as string).length).toBe(64)
    expect(typeof parsed['lock_until']).toBe('number')
    expect(typeof parsed['deposited_at']).toBe('number')

    // Amount must NOT appear anywhere in the public record
    expect(json).not.toContain('750000000')
    expect(json).not.toContain('"amount"')
    expect(json).not.toContain('amount_commitment')
    expect(json).not.toContain('amount_raw')
  })
})
