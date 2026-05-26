/**
 * Encrypted memo tests — TypeScript mirror of
 * crates/dark-encrypted-memo/src/lib.rs
 *
 * Algorithms (pure Node.js crypto):
 *   sender_pubkey        = SHA256("memo-sender-v1"  || sender_secret)
 *   keystream            = SHA256("memo-key-v1"     || shared_secret || sender_pubkey)
 *   ciphertext[i]        = plaintext[i] XOR keystream[i % 32]
 *   nonce_commitment     = SHA256("memo-nonce-v1"   || shared_secret)
 *   ciphertext_commitment = SHA256("memo-commit-v1" || ciphertext)
 *
 * Decrypt: recompute keystream, XOR back.
 * Verify:  SHA256("memo-nonce-v1" || provided_shared_secret) must equal stored nonce_commitment.
 *
 * Note: Rust encrypt_memo returns Err(EmptyMemo) for empty plaintext.
 * The TS helper below mirrors that guard; test 2 verifies the behaviour explicitly.
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
// Helpers (mirror Rust internal functions)
// ---------------------------------------------------------------------------

function deriveSenderPubkey(senderSecret: Buffer): Buffer {
  return sha256(Buffer.from('memo-sender-v1'), senderSecret)
}

function deriveKeystream(sharedSecret: Buffer, senderPubkey: Buffer): Buffer {
  return sha256(Buffer.from('memo-key-v1'), sharedSecret, senderPubkey)
}

function deriveNonceCommitment(sharedSecret: Buffer): Buffer {
  return sha256(Buffer.from('memo-nonce-v1'), sharedSecret)
}

function commitCiphertext(ciphertext: Buffer): Buffer {
  return sha256(Buffer.from('memo-commit-v1'), ciphertext)
}

function xorWithKeystream(data: Buffer, keystream: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ keystream[i % 32]
  }
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface EncryptedMemo {
  ciphertextCommitmentHex: string
  senderPubkeyHex: string
  nonceCommitmentHex: string
  ciphertext: Buffer
  sentAt: number
}

/**
 * Mirrors Rust encrypt_memo.
 * Throws when plaintext is empty (Rust returns Err(EmptyMemo)).
 */
function encryptMemo(
  plaintext: Buffer,
  sharedSecret: Buffer,
  senderSecret: Buffer,
  sentAt: number,
): EncryptedMemo {
  if (plaintext.length === 0) {
    throw new Error('EmptyMemo')
  }

  const senderPubkey = deriveSenderPubkey(senderSecret)
  const keystream = deriveKeystream(sharedSecret, senderPubkey)
  const ciphertext = xorWithKeystream(plaintext, keystream)
  const nonceCommitment = deriveNonceCommitment(sharedSecret)
  const ciphertextCommitment = commitCiphertext(ciphertext)

  return {
    ciphertextCommitmentHex: ciphertextCommitment.toString('hex'),
    senderPubkeyHex: senderPubkey.toString('hex'),
    nonceCommitmentHex: nonceCommitment.toString('hex'),
    ciphertext,
    sentAt,
  }
}

/**
 * Mirrors Rust decrypt_memo.
 * Returns null when the shared_secret is wrong (Rust returns Err(WrongSharedSecret)).
 */
function decryptMemo(
  memo: EncryptedMemo,
  sharedSecret: Buffer,
): { plaintext: Buffer; senderPubkeyHex: string; sentAt: number } | null {
  const expectedNonce = deriveNonceCommitment(sharedSecret)
  if (expectedNonce.toString('hex') !== memo.nonceCommitmentHex) {
    return null
  }

  const senderPubkey = Buffer.from(memo.senderPubkeyHex, 'hex')
  const keystream = deriveKeystream(sharedSecret, senderPubkey)
  const plaintext = xorWithKeystream(memo.ciphertext, keystream)

  return {
    plaintext,
    senderPubkeyHex: memo.senderPubkeyHex,
    sentAt: memo.sentAt,
  }
}

function memoPublicRecord(memo: EncryptedMemo): object {
  return {
    ciphertext_commitment_hex: memo.ciphertextCommitmentHex,
    sender_pubkey_hex: memo.senderPubkeyHex,
    sent_at: memo.sentAt,
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SHARED_SECRET = Buffer.alloc(32, 0xab)
const SENDER_SECRET = Buffer.alloc(32, 0x01)
const SENT_AT = 1_700_000_000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null encrypted memo', () => {
  it('happy path: encrypt and decrypt roundtrip', () => {
    const plaintext = Buffer.from('hello dark memo')
    const memo = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)

    expect(memo.ciphertext.length).toBe(plaintext.length)
    // Ciphertext must differ from plaintext (XOR with non-zero keystream)
    expect(memo.ciphertext.equals(plaintext)).toBe(false)

    const decrypted = decryptMemo(memo, SHARED_SECRET)
    expect(decrypted).not.toBeNull()
    expect(decrypted!.plaintext.equals(plaintext)).toBe(true)
    expect(decrypted!.senderPubkeyHex).toBe(memo.senderPubkeyHex)
    expect(decrypted!.sentAt).toBe(SENT_AT)
  })

  it('empty plaintext: Rust rejects with EmptyMemo; TS mirrors that guard, 0-length ciphertext is empty', () => {
    // Verify the guard throws
    expect(() => encryptMemo(Buffer.alloc(0), SHARED_SECRET, SENDER_SECRET, SENT_AT)).toThrow(
      'EmptyMemo',
    )

    // Verify directly that XOR of empty input produces empty output (the math is correct)
    const keystream = deriveKeystream(SHARED_SECRET, deriveSenderPubkey(SENDER_SECRET))
    const emptyXor = xorWithKeystream(Buffer.alloc(0), keystream)
    expect(emptyXor.length).toBe(0)
  })

  it('wrong shared secret: nonce_commitment mismatch detected', () => {
    const plaintext = Buffer.from('secret message')
    const memo = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)

    const wrongSecret = Buffer.alloc(32, 0xff)
    const result = decryptMemo(memo, wrongSecret)

    // Wrong secret → different nonce_commitment → decrypt returns null
    expect(result).toBeNull()
  })

  it('ciphertext changes when sender_secret changes', () => {
    const plaintext = Buffer.from('same plaintext, different senders')

    const memoA = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)
    const senderSecretB = Buffer.alloc(32, 0x02) // different sender
    const memoB = encryptMemo(plaintext, SHARED_SECRET, senderSecretB, SENT_AT)

    // Different sender_secret → different sender_pubkey → different keystream → different ciphertext
    expect(memoA.senderPubkeyHex).not.toBe(memoB.senderPubkeyHex)
    expect(memoA.ciphertext.equals(memoB.ciphertext)).toBe(false)
  })

  it('ciphertext_commitment is stable', () => {
    const plaintext = Buffer.from('stable commitment test')

    const memo1 = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)
    const memo2 = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)

    // Same inputs → same commitment every time
    expect(memo1.ciphertextCommitmentHex).toBe(memo2.ciphertextCommitmentHex)
    expect(memo1.senderPubkeyHex).toBe(memo2.senderPubkeyHex)
    expect(memo1.nonceCommitmentHex).toBe(memo2.nonceCommitmentHex)
  })

  it('public record shape', () => {
    const plaintext = Buffer.from('private message content')
    const memo = encryptMemo(plaintext, SHARED_SECRET, SENDER_SECRET, SENT_AT)

    const record = memoPublicRecord(memo) as Record<string, unknown>

    // Required public fields
    expect(typeof record.ciphertext_commitment_hex).toBe('string')
    expect((record.ciphertext_commitment_hex as string).length).toBe(64) // 32 bytes hex
    expect(typeof record.sender_pubkey_hex).toBe('string')
    expect((record.sender_pubkey_hex as string).length).toBe(64)
    expect(typeof record.sent_at).toBe('number')

    // Must NOT expose plaintext, raw ciphertext bytes, shared secret, or nonce_commitment
    const json = JSON.stringify(record)
    expect(json).not.toContain('private message content')
    expect(json).not.toContain(memo.ciphertext.toString('hex'))
    expect(json).not.toContain(SHARED_SECRET.toString('hex'))
    expect(json).not.toContain('nonce_commitment')
    expect(json).not.toContain('plaintext')
  })
})
