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

function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Vote-delegation primitives (mirrors crates/dark-vote-delegation)
//
// delegator_hash = SHA256("deleg-delegator-v1" || delegator_secret)
// delegatee_hash = SHA256("deleg-delegatee-v1" || delegatee_secret)
// scope_hash     = SHA256("deleg-scope-v1"      || scope_bytes)
// delegate_id    = SHA256("deleg-id-v1"         || delegator_hash || delegatee_hash || scope_hash || expires_at_i64le)
// vote_id        = SHA256("deleg-vote-v1"       || delegate_id || [choice_u8] || cast_at_i64le)
// ---------------------------------------------------------------------------

const PFX_DELEGATOR = Buffer.from('deleg-delegator-v1')
const PFX_DELEGATEE = Buffer.from('deleg-delegatee-v1')
const PFX_SCOPE     = Buffer.from('deleg-scope-v1')
const PFX_DELEG_ID  = Buffer.from('deleg-id-v1')
const PFX_VOTE      = Buffer.from('deleg-vote-v1')

function delegatorHash(secret: Buffer): Buffer {
  return sha256(PFX_DELEGATOR, secret)
}

function delegateeHash(secret: Buffer): Buffer {
  return sha256(PFX_DELEGATEE, secret)
}

function scopeHash(scopeBytes: Buffer): Buffer {
  return sha256(PFX_SCOPE, scopeBytes)
}

function delegateId(
  dHash: Buffer,
  eeHash: Buffer,
  sHash: Buffer,
  expiresAt: bigint,
): Buffer {
  return sha256(PFX_DELEG_ID, dHash, eeHash, sHash, i64le(expiresAt))
}

function voteId(delId: Buffer, choice: boolean, castAt: bigint): Buffer {
  const choiceBuf = Buffer.from([choice ? 1 : 0])
  return sha256(PFX_VOTE, delId, choiceBuf, i64le(castAt))
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
interface Delegation {
  delegate_id: Buffer
  delegator_hash: Buffer
  delegatee_hash: Buffer
  scope_hash: Buffer
  expires_at_unix: bigint
  revoked: boolean
  mainnet_ready: boolean
}

function createDelegation(
  delegatorSecret: Buffer,
  delegateeSecret: Buffer,
  scopeBytes: Buffer,
  expiresAt: bigint,
): Delegation {
  if (delegatorSecret.every(b => b === 0)) throw new Error('ZeroDelegatorSecret')
  if (delegateeSecret.every(b => b === 0)) throw new Error('ZeroDelegateeSecret')
  if (scopeBytes.length === 0) throw new Error('EmptyScope')

  const dHash  = delegatorHash(delegatorSecret)
  const eeHash = delegateeHash(delegateeSecret)
  const sHash  = scopeHash(scopeBytes)
  const delId  = delegateId(dHash, eeHash, sHash, expiresAt)

  return {
    delegate_id: delId,
    delegator_hash: dHash,
    delegatee_hash: eeHash,
    scope_hash: sHash,
    expires_at_unix: expiresAt,
    revoked: false,
    mainnet_ready: false,
  }
}

function castDelegatedVote(
  delegation: Delegation,
  choice: boolean,
  castAt: bigint,
): Buffer {
  if (delegation.revoked) throw new Error('DelegationRevoked')
  if (castAt > delegation.expires_at_unix) throw new Error('DelegationExpired')
  return voteId(delegation.delegate_id, choice, castAt)
}

function delegationPublicRecord(d: Delegation): object {
  return {
    delegate_id: d.delegate_id.toString('hex'),
    scope_hash: d.scope_hash.toString('hex'),
    expires_at_unix: d.expires_at_unix.toString(),
    revoked: d.revoked,
    mainnet_ready: d.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null vote-delegation', () => {
  const DELEGATOR_SECRET = Buffer.from('delegator-secret-0000000000000000', 'utf8')
  const DELEGATEE_SECRET = Buffer.from('delegatee-secret-0000000000000000', 'utf8')
  const SCOPE            = Buffer.from('governance-vote')
  const EXPIRES_AT       = 9_999n
  const CAST_AT          = 1_000n

  it('delegate_id computation is deterministic', () => {
    const d1 = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    const d2 = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    expect(d1.delegate_id.equals(d2.delegate_id)).toBe(true)

    // Manual recompute
    const dHash  = delegatorHash(DELEGATOR_SECRET)
    const eeHash = delegateeHash(DELEGATEE_SECRET)
    const sHash  = scopeHash(SCOPE)
    const manual = delegateId(dHash, eeHash, sHash, EXPIRES_AT)
    expect(d1.delegate_id.equals(manual)).toBe(true)
  })

  it('vote_id for choice=true is deterministic', () => {
    const d = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    const v1 = castDelegatedVote(d, true, CAST_AT)
    const v2 = castDelegatedVote(d, true, CAST_AT)
    expect(v1.equals(v2)).toBe(true)
    expect(v1.length).toBe(32)
  })

  it('vote_id for choice=false differs from choice=true', () => {
    const d      = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    const vTrue  = castDelegatedVote(d, true, CAST_AT)
    const vFalse = castDelegatedVote(d, false, CAST_AT)
    expect(vTrue.equals(vFalse)).toBe(false)
  })

  it('public record hides delegator_hash and delegatee_hash', () => {
    const d   = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    const rec = delegationPublicRecord(d) as Record<string, unknown>

    expect(typeof rec['delegate_id']).toBe('string')
    expect(rec['mainnet_ready']).toBe(false)
    expect(Object.keys(rec)).not.toContain('delegator_hash')
    expect(Object.keys(rec)).not.toContain('delegatee_hash')

    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(d.delegator_hash.toString('hex'))
    expect(serialised).not.toContain(d.delegatee_hash.toString('hex'))
  })

  it('expired delegation → error', () => {
    const d = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, 500n)
    // cast_at (1000) > expires_at (500) → rejected
    expect(() => castDelegatedVote(d, true, 1_000n)).toThrow('DelegationExpired')
    // at exactly expires_at → ok
    expect(() => castDelegatedVote(d, true, 500n)).not.toThrow()
  })

  it('mainnet_ready is false', () => {
    const d   = createDelegation(DELEGATOR_SECRET, DELEGATEE_SECRET, SCOPE, EXPIRES_AT)
    expect(d.mainnet_ready).toBe(false)
    const rec = delegationPublicRecord(d) as Record<string, unknown>
    expect(rec['mainnet_ready']).toBe(false)
  })
})
