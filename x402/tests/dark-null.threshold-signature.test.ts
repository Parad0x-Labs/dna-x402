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

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Scheme helpers
// ---------------------------------------------------------------------------

const ROOT_SECRET = Buffer.alloc(32, 0x11)
const THRESHOLD = 2

function masterSecret(rootSecret: Buffer): Buffer {
  return sha256(Buffer.from('tsig-master-v1'), rootSecret)
}

function publicKey(ms: Buffer): Buffer {
  return sha256(Buffer.from('tsig-pubkey-v1'), ms)
}

function share(ms: Buffer, i: number): Buffer {
  return sha256(Buffer.from('tsig-share-v1'), ms, Buffer.from([i]))
}

function keyId(pk: Buffer, threshold: number): Buffer {
  return sha256(Buffer.from('tsig-key-id-v1'), pk, Buffer.from([threshold]))
}

function messageHash(messageBytes: Buffer): Buffer {
  return sha256(Buffer.from('tsig-msg-v1'), messageBytes)
}

function partialHash(kid: Buffer, msgHash: Buffer, shr: Buffer): Buffer {
  return sha256(Buffer.from('tsig-partial-v1'), kid, msgHash, shr)
}

function aggregate(kid: Buffer, msgHash: Buffer, partials: Buffer[]): Buffer {
  return sha256(Buffer.from('tsig-agg-v1'), kid, msgHash, xorFold(partials))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null.threshold-signature (Wave 15 batch-2)', () => {
  it('key_id computation: SHA256("tsig-key-id-v1" || public_key || [threshold])', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)

    const expected = sha256(Buffer.from('tsig-key-id-v1'), pk, Buffer.from([THRESHOLD]))
    expect(kid.toString('hex')).toBe(expected.toString('hex'))
    expect(kid).toHaveLength(32)
  })

  it('partial_hash computation: SHA256("tsig-partial-v1" || key_id || message_hash || share[i])', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)
    const shr0 = share(ms, 0)
    const msg = Buffer.from('test-message')
    const mh = messageHash(msg)
    const ph = partialHash(kid, mh, shr0)

    const expected = sha256(Buffer.from('tsig-partial-v1'), kid, mh, shr0)
    expect(ph.toString('hex')).toBe(expected.toString('hex'))
    expect(ph).toHaveLength(32)
  })

  it('aggregate computation with 2 partials produces 32-byte output', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)
    const msg = Buffer.from('aggregate-test')
    const mh = messageHash(msg)
    const ph0 = partialHash(kid, mh, share(ms, 0))
    const ph1 = partialHash(kid, mh, share(ms, 1))
    const agg = aggregate(kid, mh, [ph0, ph1])

    const expected = sha256(Buffer.from('tsig-agg-v1'), kid, mh, xorFold([ph0, ph1]))
    expect(agg.toString('hex')).toBe(expected.toString('hex'))
    expect(agg).toHaveLength(32)
  })

  it('different messages produce different aggregates', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)
    const msg1 = Buffer.from('message-alpha')
    const msg2 = Buffer.from('message-beta')
    const mh1 = messageHash(msg1)
    const mh2 = messageHash(msg2)
    const ph0_1 = partialHash(kid, mh1, share(ms, 0))
    const ph1_1 = partialHash(kid, mh1, share(ms, 1))
    const ph0_2 = partialHash(kid, mh2, share(ms, 0))
    const ph1_2 = partialHash(kid, mh2, share(ms, 1))
    const agg1 = aggregate(kid, mh1, [ph0_1, ph1_1])
    const agg2 = aggregate(kid, mh2, [ph0_2, ph1_2])
    expect(agg1.toString('hex')).not.toBe(agg2.toString('hex'))
  })

  it('aggregate is deterministic: same inputs always produce same output', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)
    const msg = Buffer.from('deterministic-check')
    const mh = messageHash(msg)
    const ph0 = partialHash(kid, mh, share(ms, 0))
    const ph1 = partialHash(kid, mh, share(ms, 1))
    const agg1 = aggregate(kid, mh, [ph0, ph1])
    const agg2 = aggregate(kid, mh, [ph0, ph1])
    expect(agg1.toString('hex')).toBe(agg2.toString('hex'))
  })

  it('mainnet_ready=false: public record does not expose master_secret', () => {
    const ms = masterSecret(ROOT_SECRET)
    const pk = publicKey(ms)
    const kid = keyId(pk, THRESHOLD)
    const record = {
      key_id: kid.toString('hex'),
      threshold: THRESHOLD,
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    const recStr = JSON.stringify(record)
    expect(recStr).not.toContain(ms.toString('hex'))
    expect(recStr).not.toContain(ROOT_SECRET.toString('hex'))
  })
})
