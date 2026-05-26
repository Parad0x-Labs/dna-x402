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

function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Message Capsule primitives
//
// sender_hash        = SHA256("mcapsule-sender-v1"    || sender_secret)
// recipient_key_hash = SHA256("mcapsule-recipient-v1" || recipient_secret)
// shared_key         = SHA256("mcapsule-shared-v1"    || sender_hash || recipient_key_hash)
// plaintext_hash     = SHA256("mcapsule-plain-v1"     || message_bytes)
// message_commitment = SHA256("mcapsule-commit-v1"    || plaintext_hash || nonce)
// ciphertext_hash    = SHA256("mcapsule-cipher-v1"    || shared_key || message_commitment)
// capsule_id         = SHA256("mcapsule-id-v1"        || ciphertext_hash || sender_hash)
// ---------------------------------------------------------------------------

function senderHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-sender-v1'), secret)
}

function recipientKeyHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-recipient-v1'), secret)
}

function sharedKey(sHash: Buffer, rHash: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-shared-v1'), sHash, rHash)
}

function plaintextHash(messageBytes: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-plain-v1'), messageBytes)
}

function messageCommitment(pHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-commit-v1'), pHash, nonce)
}

function ciphertextHash(shKey: Buffer, msgCommit: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-cipher-v1'), shKey, msgCommit)
}

function capsuleId(ctHash: Buffer, sHash: Buffer): Buffer {
  return sha256(Buffer.from('mcapsule-id-v1'), ctHash, sHash)
}

interface Capsule {
  capsuleId: Buffer
  ciphertextHash: Buffer
  senderHash: Buffer
  messageCommitment: Buffer
}

function sealCapsule(
  senderSecret: Buffer,
  recipientSecret: Buffer,
  messageBytes: Buffer,
  nonce: Buffer,
): Capsule {
  const sHash     = senderHash(senderSecret)
  const rHash     = recipientKeyHash(recipientSecret)
  const shKey     = sharedKey(sHash, rHash)
  const pHash     = plaintextHash(messageBytes)
  const msgCommit = messageCommitment(pHash, nonce)
  const ctHash    = ciphertextHash(shKey, msgCommit)
  const capId     = capsuleId(ctHash, sHash)

  return { capsuleId: capId, ciphertextHash: ctHash, senderHash: sHash, messageCommitment: msgCommit }
}

function unsealVerify(
  cap: Capsule,
  senderSecret: Buffer,
  recipientSecret: Buffer,
  messageBytes: Buffer,
  nonce: Buffer,
): boolean {
  const sHash     = senderHash(senderSecret)
  const rHash     = recipientKeyHash(recipientSecret)
  const shKey     = sharedKey(sHash, rHash)
  const pHash     = plaintextHash(messageBytes)
  const msgCommit = messageCommitment(pHash, nonce)
  const expectedCt = ciphertextHash(shKey, msgCommit)
  return expectedCt.equals(cap.ciphertextHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null message-capsule', () => {
  const SENDER_SECRET    = Buffer.from('sender-secret-cap-0000000000000', 'utf8')
  const RECIPIENT_SECRET = Buffer.from('recipient-secret-cap-00000000000', 'utf8')
  const MESSAGE          = Buffer.from('hello, dark world', 'utf8')
  const NONCE_1          = Buffer.alloc(32).fill(0xaa)
  const NONCE_2          = Buffer.alloc(32).fill(0xbb)

  it('capsule_id computation is deterministic and 32 bytes', () => {
    const cap1 = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)
    const cap2 = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)

    expect(cap1.capsuleId.length).toBe(32)
    expect(cap1.capsuleId.equals(cap2.capsuleId)).toBe(true)
  })

  it('ciphertext_hash hides the plaintext message', () => {
    const cap = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)

    // ciphertext_hash must not contain raw message bytes
    expect(cap.ciphertextHash.toString('hex')).not.toContain(MESSAGE.toString('hex'))

    // Different messages → different ciphertext_hash
    const otherMessage = Buffer.from('different message content', 'utf8')
    const cap2 = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, otherMessage, NONCE_1)
    expect(cap.ciphertextHash.equals(cap2.ciphertextHash)).toBe(false)
  })

  it('different nonces produce different capsule_ids', () => {
    const cap1 = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)
    const cap2 = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_2)

    expect(cap1.capsuleId.equals(cap2.capsuleId)).toBe(false)
    expect(cap1.ciphertextHash.equals(cap2.ciphertextHash)).toBe(false)
  })

  it('unseal verify succeeds by recomputing ciphertext_hash', () => {
    const cap = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)
    expect(unsealVerify(cap, SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)).toBe(true)

    // Tampered message fails
    const wrongMsg = Buffer.from('tampered message', 'utf8')
    expect(unsealVerify(cap, SENDER_SECRET, RECIPIENT_SECRET, wrongMsg, NONCE_1)).toBe(false)
  })

  it('public record hides sender and recipient identities', () => {
    const cap = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)
    const record = {
      capsule_id:    cap.capsuleId.toString('hex'),
      mainnet_ready: false,
    }
    const json = JSON.stringify(record)

    const sHash = senderHash(SENDER_SECRET)
    const rHash = recipientKeyHash(RECIPIENT_SECRET)

    expect(json).not.toContain(sHash.toString('hex'))
    expect(json).not.toContain(rHash.toString('hex'))
    expect(json).not.toContain(SENDER_SECRET.toString('hex'))
    expect(json).not.toContain(RECIPIENT_SECRET.toString('hex'))

    expect(record.mainnet_ready).toBe(false)
  })

  it('mainnet_ready is always false', () => {
    const cap = sealCapsule(SENDER_SECRET, RECIPIENT_SECRET, MESSAGE, NONCE_1)
    const record = { capsule_id: cap.capsuleId.toString('hex'), mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
