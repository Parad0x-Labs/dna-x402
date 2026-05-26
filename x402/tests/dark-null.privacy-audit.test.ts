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

const AUDITOR_SECRET = Buffer.alloc(32, 0xaa)
const NONCE = Buffer.alloc(32, 0x55)

function auditorHash(auditorSecret: Buffer): Buffer {
  return sha256(Buffer.from('audit2-auditor-v1'), auditorSecret)
}

function trailId(ah: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('audit2-trail-v1'), ah, nonce)
}

function eventHash(eventBytes: Buffer): Buffer {
  return sha256(Buffer.from('audit2-event-v1'), eventBytes)
}

function eventId(prevHead: Buffer, eh: Buffer, seq: number): Buffer {
  return sha256(Buffer.from('audit2-link-v1'), prevHead, eh, u32le(seq))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null.privacy-audit (Wave 15 batch-2)', () => {
  it('trail_id = SHA256("audit2-trail-v1" || auditor_hash || nonce)', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)

    const expected = sha256(Buffer.from('audit2-trail-v1'), ah, NONCE)
    expect(tid.toString('hex')).toBe(expected.toString('hex'))
    expect(tid).toHaveLength(32)
  })

  it('event_id for seq=0 uses prev=trail_id: SHA256("audit2-link-v1" || trail_id || event_hash || u32le(0))', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)
    const ev0Bytes = Buffer.from('event-zero-data')
    const eh0 = eventHash(ev0Bytes)
    const eid0 = eventId(tid, eh0, 0)

    const expected = sha256(Buffer.from('audit2-link-v1'), tid, eh0, u32le(0))
    expect(eid0.toString('hex')).toBe(expected.toString('hex'))
    expect(eid0).toHaveLength(32)
  })

  it('event_id for seq=1 uses prev=event0_id: SHA256("audit2-link-v1" || event0_id || event_hash || u32le(1))', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)
    const eh0 = eventHash(Buffer.from('event-zero'))
    const eid0 = eventId(tid, eh0, 0)
    const eh1 = eventHash(Buffer.from('event-one'))
    const eid1 = eventId(eid0, eh1, 1)

    const expected = sha256(Buffer.from('audit2-link-v1'), eid0, eh1, u32le(1))
    expect(eid1.toString('hex')).toBe(expected.toString('hex'))
    expect(eid1).toHaveLength(32)
  })

  it('different events produce different event_ids at same seq', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)
    const eh_a = eventHash(Buffer.from('event-alpha'))
    const eh_b = eventHash(Buffer.from('event-beta'))
    const eid_a = eventId(tid, eh_a, 0)
    const eid_b = eventId(tid, eh_b, 0)
    expect(eid_a.toString('hex')).not.toBe(eid_b.toString('hex'))
  })

  it('chain replay: replaying events in order produces same chain of event_ids', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)
    const events = ['evt-A', 'evt-B', 'evt-C'].map(s => Buffer.from(s))

    // Build chain first time
    const chain1: Buffer[] = []
    let prev = tid
    for (let i = 0; i < events.length; i++) {
      const eh = eventHash(events[i])
      const eid = eventId(prev, eh, i)
      chain1.push(eid)
      prev = eid
    }

    // Replay chain
    const chain2: Buffer[] = []
    prev = tid
    for (let i = 0; i < events.length; i++) {
      const eh = eventHash(events[i])
      const eid = eventId(prev, eh, i)
      chain2.push(eid)
      prev = eid
    }

    for (let i = 0; i < chain1.length; i++) {
      expect(chain1[i].toString('hex')).toBe(chain2[i].toString('hex'))
    }
  })

  it('mainnet_ready=false: public record does not expose auditor_secret', () => {
    const ah = auditorHash(AUDITOR_SECRET)
    const tid = trailId(ah, NONCE)
    const record = {
      trail_id: tid.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    const recStr = JSON.stringify(record)
    expect(recStr).not.toContain(AUDITOR_SECRET.toString('hex'))
    expect(recStr).not.toContain(ah.toString('hex'))
  })
})
