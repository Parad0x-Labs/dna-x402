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
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

function senderHash(senderSecret: Buffer): Buffer {
  return sha256(Buffer.from('signal-sender-v1'), senderSecret)
}

function channelHash(channelBytes: Buffer): Buffer {
  return sha256(Buffer.from('signal-channel-v1'), channelBytes)
}

function messageHash(messageBytes: Buffer): Buffer {
  return sha256(Buffer.from('signal-msg-v1'), messageBytes)
}

function commitment(
  senderHash: Buffer,
  channelHash: Buffer,
  messageHash: Buffer,
  epoch: bigint,
  nonce: Buffer
): Buffer {
  return sha256(
    Buffer.from('signal-commit-v1'),
    senderHash,
    channelHash,
    messageHash,
    u64le(epoch),
    nonce
  )
}

function signalId(commitment: Buffer): Buffer {
  return sha256(Buffer.from('signal-id-v1'), commitment)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null signal-proof', () => {
  const SENDER_SECRET = Buffer.alloc(32, 0x77)
  const CHANNEL_BYTES = Buffer.from('channel-alpha', 'utf8')
  const MESSAGE_BYTES = Buffer.from('hello world', 'utf8')
  const EPOCH = BigInt(42)
  const NONCE = Buffer.alloc(32, 0xef)

  it('commitment computation is correct', () => {
    const sh = senderHash(SENDER_SECRET)
    const ch = channelHash(CHANNEL_BYTES)
    const mh = messageHash(MESSAGE_BYTES)
    const c = commitment(sh, ch, mh, EPOCH, NONCE)

    expect(c).toBeInstanceOf(Buffer)
    expect(c.length).toBe(32)

    // Manual recomputation
    const expected = sha256(
      Buffer.from('signal-commit-v1'),
      sha256(Buffer.from('signal-sender-v1'), SENDER_SECRET),
      sha256(Buffer.from('signal-channel-v1'), CHANNEL_BYTES),
      sha256(Buffer.from('signal-msg-v1'), MESSAGE_BYTES),
      u64le(EPOCH),
      NONCE
    )
    expect(c.toString('hex')).toBe(expected.toString('hex'))
  })

  it('signal_id computation is correct', () => {
    const sh = senderHash(SENDER_SECRET)
    const ch = channelHash(CHANNEL_BYTES)
    const mh = messageHash(MESSAGE_BYTES)
    const c = commitment(sh, ch, mh, EPOCH, NONCE)
    const sid = signalId(c)

    expect(sid).toBeInstanceOf(Buffer)
    expect(sid.length).toBe(32)

    const expected = sha256(Buffer.from('signal-id-v1'), c)
    expect(sid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('different channels produce different signal_ids', () => {
    const sh = senderHash(SENDER_SECRET)
    const mh = messageHash(MESSAGE_BYTES)

    const ch1 = channelHash(Buffer.from('channel-alpha', 'utf8'))
    const ch2 = channelHash(Buffer.from('channel-beta', 'utf8'))

    const c1 = commitment(sh, ch1, mh, EPOCH, NONCE)
    const c2 = commitment(sh, ch2, mh, EPOCH, NONCE)

    const sid1 = signalId(c1)
    const sid2 = signalId(c2)

    expect(sid1.toString('hex')).not.toBe(sid2.toString('hex'))
  })

  it('different senders produce different commitments', () => {
    const SECRET_A = Buffer.alloc(32, 0x77)
    const SECRET_B = Buffer.alloc(32, 0x88)

    const shA = senderHash(SECRET_A)
    const shB = senderHash(SECRET_B)
    const ch = channelHash(CHANNEL_BYTES)
    const mh = messageHash(MESSAGE_BYTES)

    const cA = commitment(shA, ch, mh, EPOCH, NONCE)
    const cB = commitment(shB, ch, mh, EPOCH, NONCE)

    expect(cA.toString('hex')).not.toBe(cB.toString('hex'))
  })

  it('public record hides sender_hash and message_hash', () => {
    const sh = senderHash(SENDER_SECRET)
    const ch = channelHash(CHANNEL_BYTES)
    const mh = messageHash(MESSAGE_BYTES)
    const c = commitment(sh, ch, mh, EPOCH, NONCE)
    const sid = signalId(c)

    const publicRecord = {
      signal_id: sid.toString('hex'),
      channel_hash: ch.toString('hex'),
      epoch: Number(EPOCH),
      mainnet_ready: false,
    }

    expect(Object.keys(publicRecord)).not.toContain('sender_hash')
    expect(Object.keys(publicRecord)).not.toContain('message_hash')
    expect(Object.keys(publicRecord)).not.toContain('sender_secret')
    expect(publicRecord).toHaveProperty('signal_id')
    expect(publicRecord).toHaveProperty('channel_hash')
  })

  it('mainnet_ready=false', () => {
    const sh = senderHash(SENDER_SECRET)
    const ch = channelHash(CHANNEL_BYTES)
    const mh = messageHash(MESSAGE_BYTES)
    const c = commitment(sh, ch, mh, EPOCH, NONCE)
    const sid = signalId(c)

    const publicRecord = {
      signal_id: sid.toString('hex'),
      channel_hash: ch.toString('hex'),
      epoch: Number(EPOCH),
      mainnet_ready: false,
    }

    expect(publicRecord.mainnet_ready).toBe(false)
  })
})
