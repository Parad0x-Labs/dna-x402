import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

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
// Primitives matching crates/dark-access-token/src/lib.rs
// ---------------------------------------------------------------------------

function issuer_hash(issuer_secret: Buffer): Buffer {
  return sha256(Buffer.from('issuer-hash-v1'), issuer_secret)
}

function scope_hash(scope_bytes: Buffer): Buffer {
  return sha256(Buffer.from('scope-hash-v1'), scope_bytes)
}

function holder_hash(holder_secret: Buffer): Buffer {
  return sha256(Buffer.from('holder-hash-v1'), holder_secret)
}

function token_id(
  ih: Buffer,
  sh: Buffer,
  hh: Buffer,
  issued_at: bigint,
  expires_at: bigint,
): Buffer {
  return sha256(
    Buffer.from('access-token-v1'),
    ih,
    sh,
    hh,
    u64le(issued_at),
    u64le(expires_at),
  )
}

interface AccessToken {
  token_id: Buffer
  token_id_hex: string
  scope_hash_hex: string
  issued_at: bigint
  expires_at: bigint
  revoked: boolean
  // kept internally for verify; NOT in public_record
  _issuer_hash: Buffer
  _holder_hash: Buffer
}

function issue_token(
  issuer_secret: Buffer,
  scope_bytes: Buffer,
  holder_secret: Buffer,
  issued_at: bigint,
  expires_at: bigint,
): AccessToken {
  const ih = issuer_hash(issuer_secret)
  const sh = scope_hash(scope_bytes)
  const hh = holder_hash(holder_secret)
  const tid = token_id(ih, sh, hh, issued_at, expires_at)
  return {
    token_id: tid,
    token_id_hex: tid.toString('hex'),
    scope_hash_hex: sh.toString('hex'),
    issued_at,
    expires_at,
    revoked: false,
    _issuer_hash: ih,
    _holder_hash: hh,
  }
}

type VerifyError = 'Expired' | 'Revoked' | 'ScopeMismatch' | 'InvalidToken'

function verify_token(
  token: AccessToken,
  issuer_secret: Buffer,
  scope_bytes: Buffer,
  holder_secret: Buffer,
  now: bigint,
): { ok: true } | { ok: false; error: VerifyError } {
  if (token.revoked) return { ok: false, error: 'Revoked' }
  if (now > token.expires_at) return { ok: false, error: 'Expired' }

  const sh = scope_hash(scope_bytes)
  if (sh.toString('hex') !== token.scope_hash_hex) return { ok: false, error: 'ScopeMismatch' }

  const ih = issuer_hash(issuer_secret)
  const hh = holder_hash(holder_secret)
  const expected = token_id(ih, sh, hh, token.issued_at, token.expires_at)
  if (!expected.equals(token.token_id)) return { ok: false, error: 'InvalidToken' }

  return { ok: true }
}

function public_record(token: AccessToken): {
  token_id_hex: string
  scope_hash_hex: string
  issued_at: string
  expires_at: string
  revoked: boolean
} {
  return {
    token_id_hex: token.token_id_hex,
    scope_hash_hex: token.scope_hash_hex,
    issued_at: token.issued_at.toString(),
    expires_at: token.expires_at.toString(),
    revoked: token.revoked,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ISSUER = Buffer.from('issuer-secret-abc')
const HOLDER = Buffer.from('holder-secret-xyz')
const SCOPE = Buffer.from('read:data')
const NOW = 1_000_000n
const ISSUED = 999_000n
const EXPIRES = 1_001_000n

describe('dark-access-token', () => {
  it('issue and verify happy path', () => {
    const token = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const result = verify_token(token, ISSUER, SCOPE, HOLDER, NOW)
    expect(result.ok).toBe(true)
  })

  it('expired: current > expires_at → rejected', () => {
    const token = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const after = EXPIRES + 1n
    const result = verify_token(token, ISSUER, SCOPE, HOLDER, after)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Expired')
  })

  it('revoked: set revoked=true → rejected', () => {
    const token = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const revoked = { ...token, revoked: true }
    const result = verify_token(revoked, ISSUER, SCOPE, HOLDER, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Revoked')
  })

  it('scope mismatch: verify with different scope_bytes', () => {
    const token = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const wrong_scope = Buffer.from('write:data')
    const result = verify_token(token, ISSUER, wrong_scope, HOLDER, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('ScopeMismatch')
  })

  it('token_id is deterministic', () => {
    const a = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const b = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    expect(a.token_id_hex).toBe(b.token_id_hex)

    // Different holder → different token_id
    const other_holder = Buffer.from('different-holder')
    const c = issue_token(ISSUER, SCOPE, other_holder, ISSUED, EXPIRES)
    expect(a.token_id_hex).not.toBe(c.token_id_hex)
  })

  it('public record: token_id_hex, scope_hash_hex, timestamps, revoked; no issuer_hash or holder_hash', () => {
    const token = issue_token(ISSUER, SCOPE, HOLDER, ISSUED, EXPIRES)
    const rec = public_record(token)

    expect(typeof rec.token_id_hex).toBe('string')
    expect(rec.token_id_hex).toHaveLength(64)
    expect(typeof rec.scope_hash_hex).toBe('string')
    expect(rec.scope_hash_hex).toHaveLength(64)
    expect(rec.issued_at).toBe(ISSUED.toString())
    expect(rec.expires_at).toBe(EXPIRES.toString())
    expect(rec.revoked).toBe(false)

    const recStr = JSON.stringify(rec)
    expect(recStr).not.toContain('issuer_hash')
    expect(recStr).not.toContain('holder_hash')
    expect(recStr).not.toContain('_issuer')
    expect(recStr).not.toContain('_holder')
    // Raw secrets must not leak
    expect(recStr).not.toContain(ISSUER.toString('hex'))
    expect(recStr).not.toContain(HOLDER.toString('hex'))
  })
})
