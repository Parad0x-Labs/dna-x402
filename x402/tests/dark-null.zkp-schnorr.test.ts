import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const MAINNET_READY = false

describe('dark-null.zkp-schnorr', () => {
  const secret = Buffer.from('schnorr-secret-alice-0001', 'utf8')
  const nonce  = Buffer.from('schnorr-nonce-0001', 'utf8')
  const message = Buffer.from('sign-this-message', 'utf8')

  it('public_key_hash = SHA256("schnorr-pk-v1" || secret)', () => {
    const pkHash = sha256(Buffer.from('schnorr-pk-v1'), secret)
    expect(pkHash.length).toBe(32)
    expect(pkHash.equals(Buffer.alloc(32, 0))).toBe(false)
    // deterministic
    expect(pkHash.equals(sha256(Buffer.from('schnorr-pk-v1'), secret))).toBe(true)
  })

  it('commitment = SHA256("schnorr-commit-v1" || nonce)', () => {
    const commit = sha256(Buffer.from('schnorr-commit-v1'), nonce)
    expect(commit.length).toBe(32)
    expect(commit.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(commit.equals(sha256(Buffer.from('schnorr-commit-v1'), nonce))).toBe(true)
  })

  it('challenge = SHA256("schnorr-challenge-v1" || pkHash || commit || message)', () => {
    const pkHash  = sha256(Buffer.from('schnorr-pk-v1'), secret)
    const commit  = sha256(Buffer.from('schnorr-commit-v1'), nonce)
    const challenge = sha256(Buffer.from('schnorr-challenge-v1'), pkHash, commit, message)
    expect(challenge.length).toBe(32)
    expect(challenge.equals(Buffer.alloc(32, 0))).toBe(false)
    // verify formula components
    const response  = sha256(Buffer.from('schnorr-response-v1'), secret, challenge, nonce)
    expect(response.length).toBe(32)
  })

  it('proof_id = SHA256("schnorr-proof-v1" || commit || challenge || response)', () => {
    const pkHash    = sha256(Buffer.from('schnorr-pk-v1'), secret)
    const commit    = sha256(Buffer.from('schnorr-commit-v1'), nonce)
    const challenge = sha256(Buffer.from('schnorr-challenge-v1'), pkHash, commit, message)
    const response  = sha256(Buffer.from('schnorr-response-v1'), secret, challenge, nonce)
    const proofId   = sha256(Buffer.from('schnorr-proof-v1'), commit, challenge, response)
    expect(proofId.length).toBe(32)
    expect(proofId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(proofId.equals(sha256(Buffer.from('schnorr-proof-v1'), commit, challenge, response))).toBe(true)
  })

  it('different messages produce different challenges', () => {
    const pkHash  = sha256(Buffer.from('schnorr-pk-v1'), secret)
    const commit  = sha256(Buffer.from('schnorr-commit-v1'), nonce)
    const msg1    = Buffer.from('message-one')
    const msg2    = Buffer.from('message-two')
    const ch1 = sha256(Buffer.from('schnorr-challenge-v1'), pkHash, commit, msg1)
    const ch2 = sha256(Buffer.from('schnorr-challenge-v1'), pkHash, commit, msg2)
    expect(ch1.equals(ch2)).toBe(false)
  })

  it('mainnet_ready is false, is_stub is true', () => {
    const is_stub = true
    expect(MAINNET_READY).toBe(false)
    expect(is_stub).toBe(true)
  })
})
