import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Blind Signature scheme
// Mirrors crates/dark-blind-signature/src/lib.rs
// ---------------------------------------------------------------------------

const MSG_TAG    = Buffer.from('blind-sig-msg-v1')
const BLIND_TAG  = Buffer.from('blind-sig-blind-v1')
const PUB_TAG    = Buffer.from('blind-sig-pub-v1')
const SIGN_TAG   = Buffer.from('blind-sig-sign-v1')

function messageHash(message: Buffer): Buffer {
  return sha256(MSG_TAG, message)
}

function blindMessage(msgHash: Buffer, blindingFactor: Buffer): Buffer {
  if (blindingFactor.equals(Buffer.alloc(32, 0))) throw new Error('zero blinding factor not allowed')
  return sha256(BLIND_TAG, msgHash, blindingFactor)
}

function signerPublicKey(signerSecret: Buffer): Buffer {
  return sha256(PUB_TAG, signerSecret)
}

function signBlinded(signerSecret: Buffer, blinded: Buffer): Buffer {
  const pubkey = signerPublicKey(signerSecret)
  return sha256(SIGN_TAG, pubkey, blinded)
}

interface UnblindedSig {
  message_hash: Buffer
  signature: Buffer
  signer_pubkey: Buffer
}

function unblind(
  message: Buffer,
  blindingFactor: Buffer,
  signerSecret: Buffer,
  signature: Buffer,
): UnblindedSig {
  const msgHash  = messageHash(message)
  const blinded  = blindMessage(msgHash, blindingFactor)
  const pubkey   = signerPublicKey(signerSecret)
  const expected = sha256(SIGN_TAG, pubkey, blinded)

  if (!signature.equals(expected)) throw new Error('unblind failed: signature mismatch')

  return { message_hash: msgHash, signature, signer_pubkey: pubkey }
}

function verifyUnblinded(result: UnblindedSig): boolean {
  return (
    result.message_hash.length === 32 &&
    result.signature.length === 32 &&
    !result.signature.equals(Buffer.alloc(32, 0))
  )
}

const mainnet_ready = false

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null blind-signature', () => {
  const secret  = Buffer.from('signer-secret-key-32bytes-------', 'utf8').subarray(0, 32)
  const bfactor = Buffer.from('blinding-factor-32bytes---------', 'utf8').subarray(0, 32)
  const msg     = Buffer.from('hello blind world', 'utf8')

  it('mainnet_ready flag is false', () => {
    expect(mainnet_ready).toBe(false)
  })

  it('full blind/sign/unblind roundtrip', () => {
    const msgHash  = messageHash(msg)
    const blinded  = blindMessage(msgHash, bfactor)
    const sig      = signBlinded(secret, blinded)
    const result   = unblind(msg, bfactor, secret, sig)

    expect(result.message_hash.equals(msgHash)).toBe(true)
    expect(result.signature.equals(sig)).toBe(true)
    expect(result.signer_pubkey.equals(signerPublicKey(secret))).toBe(true)
  })

  it('wrong blinding factor changes blinded value', () => {
    const msgHash   = messageHash(msg)
    const bf2       = Buffer.from('different-blinding-factor-------', 'utf8').subarray(0, 32)
    const blinded1  = blindMessage(msgHash, bfactor)
    const blinded2  = blindMessage(msgHash, bf2)
    expect(blinded1.equals(blinded2)).toBe(false)
  })

  it('wrong blinding factor causes unblind to throw', () => {
    const msgHash  = messageHash(msg)
    const blinded  = blindMessage(msgHash, bfactor)
    const sig      = signBlinded(secret, blinded)

    const wrongBf = Buffer.from('wrong-blinding-factor-----------', 'utf8').subarray(0, 32)
    expect(() => unblind(msg, wrongBf, secret, sig)).toThrow()
  })

  it('zero blinding factor is rejected', () => {
    const msgHash = messageHash(msg)
    expect(() => blindMessage(msgHash, Buffer.alloc(32, 0))).toThrow()
  })

  it('different messages produce different signatures (same signer)', () => {
    const msg2 = Buffer.from('different message', 'utf8')

    const msgHash1  = messageHash(msg)
    const msgHash2  = messageHash(msg2)
    const blinded1  = blindMessage(msgHash1, bfactor)
    const blinded2  = blindMessage(msgHash2, bfactor)
    const sig1      = signBlinded(secret, blinded1)
    const sig2      = signBlinded(secret, blinded2)

    expect(sig1.equals(sig2)).toBe(false)
  })

  it('verify_unblinded: signature is non-zero and fields are 32 bytes', () => {
    const msgHash = messageHash(msg)
    const blinded = blindMessage(msgHash, bfactor)
    const sig     = signBlinded(secret, blinded)
    const result  = unblind(msg, bfactor, secret, sig)

    expect(verifyUnblinded(result)).toBe(true)
  })
})
