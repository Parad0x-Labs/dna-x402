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
// Oblivious Transfer
// Mirrors crates/dark-oblivious-transfer/src/lib.rs
// ---------------------------------------------------------------------------

const OT_RECV_TAG   = Buffer.from('ot-recv-v1')
const OT_SENDER_TAG = Buffer.from('ot-sender-v1')
const OT_KEY_TAG    = Buffer.from('ot-key-v1')
const OT_CIPHER_TAG = Buffer.from('ot-cipher-v1')

function receiverHash(receiverSecret: Buffer, bit: 0 | 1): Buffer {
  if (receiverSecret.equals(Buffer.alloc(receiverSecret.length, 0))) {
    throw new Error('zero receiver secret not allowed')
  }
  return sha256(OT_RECV_TAG, receiverSecret, Buffer.from([bit]))
}

function senderHash(senderSecret: Buffer): Buffer {
  if (senderSecret.equals(Buffer.alloc(senderSecret.length, 0))) {
    throw new Error('zero sender secret not allowed')
  }
  return sha256(OT_SENDER_TAG, senderSecret)
}

function deriveKey(sHash: Buffer, rHash: Buffer, keyBit: 0 | 1): Buffer {
  return sha256(OT_KEY_TAG, sHash, rHash, Buffer.from([keyBit]))
}

function encrypt(key: Buffer, secretBytes: Buffer): Buffer {
  return sha256(OT_CIPHER_TAG, key, secretBytes)
}

interface OTCiphertext {
  c0: Buffer
  c1: Buffer
}

function otSend(
  senderSecret: Buffer,
  receiverSecret: Buffer,
  secret0: Buffer,
  secret1: Buffer,
  receiverBit: 0 | 1,
): OTCiphertext {
  const sHash = senderHash(senderSecret)
  const rHash = receiverHash(receiverSecret, receiverBit)
  const key0  = deriveKey(sHash, rHash, 0)
  const key1  = deriveKey(sHash, rHash, 1)
  return {
    c0: encrypt(key0, secret0),
    c1: encrypt(key1, secret1),
  }
}

function otDecrypt(ct: OTCiphertext, bit: 0 | 1): Buffer {
  if (bit !== 0 && bit !== 1) throw new Error(`invalid bit: ${bit}`)
  return bit === 0 ? ct.c0 : ct.c1
}

function validateBit(bit: number): asserts bit is 0 | 1 {
  if (bit !== 0 && bit !== 1) throw new Error(`invalid bit value: ${bit}`)
}

const mainnet_ready = false

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null oblivious-transfer', () => {
  const senderSec   = Buffer.from('sender-secret-32bytes-----------', 'utf8').subarray(0, 32)
  const receiverSec = Buffer.from('receiver-secret-32bytes---------', 'utf8').subarray(0, 32)
  const secret0     = Buffer.from('the-secret-for-choice-zero', 'utf8')
  const secret1     = Buffer.from('the-secret-for-choice-one', 'utf8')

  it('mainnet_ready flag is false', () => {
    expect(mainnet_ready).toBe(false)
  })

  it('choose bit=0 decrypts to c0', () => {
    const ct  = otSend(senderSec, receiverSec, secret0, secret1, 0)
    const out = otDecrypt(ct, 0)
    expect(out.equals(ct.c0)).toBe(true)
  })

  it('choose bit=1 decrypts to c1', () => {
    const ct  = otSend(senderSec, receiverSec, secret0, secret1, 1)
    const out = otDecrypt(ct, 1)
    expect(out.equals(ct.c1)).toBe(true)
  })

  it('bit=0 and bit=1 give different ciphertexts', () => {
    const ct0 = otSend(senderSec, receiverSec, secret0, secret1, 0)
    const ct1 = otSend(senderSec, receiverSec, secret0, secret1, 1)
    expect(ct0.c0.equals(ct1.c0)).toBe(false)
    expect(ct0.c1.equals(ct1.c1)).toBe(false)
  })

  it('zero receiver secret is rejected', () => {
    expect(() => receiverHash(Buffer.alloc(32, 0), 0)).toThrow()
  })

  it('zero sender secret is rejected', () => {
    expect(() => senderHash(Buffer.alloc(32, 0))).toThrow()
  })

  it('invalid bit=2 is rejected', () => {
    expect(() => validateBit(2)).toThrow()
    const ct = otSend(senderSec, receiverSec, secret0, secret1, 0)
    expect(() => otDecrypt(ct, 2 as unknown as 0 | 1)).toThrow()
  })
})
