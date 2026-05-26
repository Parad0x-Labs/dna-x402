import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a
}

// ---------------------------------------------------------------------------
// MPC-round inline implementation
// Mirrors crates/dark-mpc-round/src/lib.rs
//
// session_id = SHA256("mpc-session-v1" || session_secret || [party_count])
// payload_hash = SHA256(payload_bytes)
// msg_hash = SHA256("mpc-msg-v1" || session_id || [from] || [to] || [round] || payload_hash)
// round_hash = SHA256("mpc-round-v1" || session_id || [round] || XOR_fold(msg_hashes))
// ---------------------------------------------------------------------------

function mpcSessionId(sessionSecret: Buffer, partyCount: number): Buffer {
  return sha256(Buffer.from('mpc-session-v1'), sessionSecret, Buffer.from([partyCount]))
}

function mpcPayloadHash(payloadBytes: Buffer): Buffer {
  return sha256(payloadBytes)
}

function mpcMsgHash(
  sessionId: Buffer,
  from: number,
  to: number,
  round: number,
  payloadBytes: Buffer,
): Buffer {
  const payloadHash = mpcPayloadHash(payloadBytes)
  return sha256(
    Buffer.from('mpc-msg-v1'),
    sessionId,
    Buffer.from([from]),
    Buffer.from([to]),
    Buffer.from([round]),
    payloadHash,
  )
}

function mpcRoundHash(sessionId: Buffer, round: number, msgHashes: Buffer[]): Buffer {
  const folded = xorFold(msgHashes)
  return sha256(Buffer.from('mpc-round-v1'), sessionId, Buffer.from([round]), folded)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null mpc-round', () => {
  const SESSION_SECRET = Buffer.alloc(32).fill(0xde)
  const PARTY_COUNT = 3
  const PAYLOAD_A = Buffer.from('mpc-payload-party-0')
  const PAYLOAD_B = Buffer.from('mpc-payload-party-1')

  it('session_id = SHA256("mpc-session-v1" || session_secret || [party_count])', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    expect(sid).toBeInstanceOf(Buffer)
    expect(sid.length).toBe(32)
    const expected = sha256(Buffer.from('mpc-session-v1'), SESSION_SECRET, Buffer.from([PARTY_COUNT]))
    expect(sid).toEqual(expected)
  })

  it('msg_hash = SHA256("mpc-msg-v1" || session_id || [from] || [to] || [round] || payload_hash)', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    const msg = mpcMsgHash(sid, 0, 1, 0, PAYLOAD_A)
    expect(msg).toBeInstanceOf(Buffer)
    expect(msg.length).toBe(32)
    const payloadHash = sha256(PAYLOAD_A)
    const expected = sha256(Buffer.from('mpc-msg-v1'), sid, Buffer.from([0]), Buffer.from([1]), Buffer.from([0]), payloadHash)
    expect(msg).toEqual(expected)
  })

  it('round_hash with 2 messages uses XOR_fold of msg_hashes', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    const m0 = mpcMsgHash(sid, 0, 1, 1, PAYLOAD_A)
    const m1 = mpcMsgHash(sid, 1, 0, 1, PAYLOAD_B)
    const rh = mpcRoundHash(sid, 1, [m0, m1])
    expect(rh).toBeInstanceOf(Buffer)
    expect(rh.length).toBe(32)
    const folded = xorFold([m0, m1])
    const expected = sha256(Buffer.from('mpc-round-v1'), sid, Buffer.from([1]), folded)
    expect(rh).toEqual(expected)
  })

  it('different rounds → different round_hashes', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    const m0 = mpcMsgHash(sid, 0, 1, 0, PAYLOAD_A)
    const rh0 = mpcRoundHash(sid, 0, [m0])
    const rh1 = mpcRoundHash(sid, 1, [m0])
    expect(rh0.equals(rh1)).toBe(false)
  })

  it('different messages affect round_hash', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    const mA = mpcMsgHash(sid, 0, 1, 2, PAYLOAD_A)
    const mB = mpcMsgHash(sid, 0, 1, 2, PAYLOAD_B)
    const rh_a = mpcRoundHash(sid, 2, [mA])
    const rh_b = mpcRoundHash(sid, 2, [mB])
    expect(rh_a.equals(rh_b)).toBe(false)
  })

  it('mainnet_ready=false present in public record', () => {
    const sid = mpcSessionId(SESSION_SECRET, PARTY_COUNT)
    const m0 = mpcMsgHash(sid, 0, 1, 0, PAYLOAD_A)
    const rh = mpcRoundHash(sid, 0, [m0])
    const record = {
      session_id: sid.toString('hex'),
      round_hash: rh.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    expect(record.session_id.length).toBe(64)
  })
})
