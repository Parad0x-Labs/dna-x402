import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u8(n: number): Buffer { return Buffer.from([n]) }
function xor(a: Buffer, b: Buffer): Buffer { return Buffer.from(a.map((byte, i) => byte ^ b[i])) }

// ---------------------------------------------------------------------------
// TX-Capsule primitives (mirrors crates/dark-tx-capsule/src/lib.rs)
//
// sender_hash        = SHA256("tx-sender-v1"  || sender_secret)
// payload_commitment = SHA256("tx-payload-v1" || payload)
// capsule_id         = SHA256("tx-capsule-v1" || payload_commitment || sender_hash || unlock_at_le[8])
// ---------------------------------------------------------------------------

function sender_hash(sender_secret: Buffer): Buffer {
  return sha256(Buffer.from('tx-sender-v1'), sender_secret)
}

function payload_commitment(payload: Buffer): Buffer {
  return sha256(Buffer.from('tx-payload-v1'), payload)
}

function capsule_id(
  pay_cm: Buffer,
  s_hash: Buffer,
  unlock_at: bigint,
): Buffer {
  return sha256(Buffer.from('tx-capsule-v1'), pay_cm, s_hash, u64le(unlock_at))
}

interface TxCapsule {
  capsule_id:         Buffer
  payload_commitment: Buffer
  sender_hash:        Buffer    // kept private; in public record this is hidden
  unlock_at:          bigint
  revealed:           boolean
}

function seal(
  sender_secret: Buffer,
  payload: Buffer,
  unlock_at: bigint,
): TxCapsule {
  const s_hash = sender_hash(sender_secret)
  const pay_cm = payload_commitment(payload)
  const cid    = capsule_id(pay_cm, s_hash, unlock_at)
  return {
    capsule_id:         cid,
    payload_commitment: pay_cm,
    sender_hash:        s_hash,
    unlock_at,
    revealed:           false,
  }
}

function reveal(
  capsule: TxCapsule,
  current_slot: bigint,
  payload: Buffer,
): Buffer {
  if (current_slot < capsule.unlock_at) throw new Error('TooEarly')
  if (capsule.revealed) throw new Error('AlreadyRevealed')

  // Verify payload matches commitment
  const expected_cm = payload_commitment(payload)
  if (!expected_cm.equals(capsule.payload_commitment)) throw new Error('WrongPayload')

  capsule.revealed = true
  return payload
}

function public_record(capsule: TxCapsule): object {
  return {
    capsule_id:    capsule.capsule_id.toString('hex'),
    unlock_at:     capsule.unlock_at.toString(),
    revealed:      capsule.revealed,
    // sender_hash and payload are hidden
    sender_hash:   null,
    payload:       null,
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null tx-capsule', () => {
  const SENDER_SECRET = Buffer.alloc(32).fill(0x5e)
  const PAYLOAD       = Buffer.from('execute-swap-usdc-sol', 'utf8')
  const WRONG_PAYLOAD = Buffer.from('execute-swap-usdc-eth', 'utf8')
  const UNLOCK_AT     = 1_000n

  it('seal and reveal at exactly unlock_at succeeds', () => {
    const cap = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)

    expect(cap.capsule_id.length).toBe(32)
    expect(cap.revealed).toBe(false)

    const revealed = reveal(cap, UNLOCK_AT, PAYLOAD)
    expect(revealed.equals(PAYLOAD)).toBe(true)
    expect(cap.revealed).toBe(true)
  })

  it('too early rejected (current_slot < unlock_at)', () => {
    const cap = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    expect(() => reveal(cap, UNLOCK_AT - 1n, PAYLOAD)).toThrow('TooEarly')
    // One before unlock is also too early
    expect(() => reveal(cap, 0n, PAYLOAD)).toThrow('TooEarly')
  })

  it('wrong payload rejected', () => {
    const cap = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    expect(() => reveal(cap, UNLOCK_AT, WRONG_PAYLOAD)).toThrow('WrongPayload')
  })

  it('double reveal rejected', () => {
    const cap = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    reveal(cap, UNLOCK_AT, PAYLOAD)
    expect(() => reveal(cap, UNLOCK_AT, PAYLOAD)).toThrow('AlreadyRevealed')
  })

  it('capsule_id is deterministic for same inputs', () => {
    const cap_a = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    const cap_b = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    expect(cap_a.capsule_id.equals(cap_b.capsule_id)).toBe(true)

    // Different unlock_at → different capsule_id
    const cap_c = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT + 1n)
    expect(cap_a.capsule_id.equals(cap_c.capsule_id)).toBe(false)
  })

  it('public record hides sender_hash and payload, mainnet_ready is false', () => {
    const cap = seal(SENDER_SECRET, PAYLOAD, UNLOCK_AT)
    const rec = public_record(cap) as Record<string, unknown>

    expect(rec['sender_hash']).toBeNull()
    expect(rec['payload']).toBeNull()
    expect(rec['unlock_at']).toBe(UNLOCK_AT.toString())
    expect(rec['revealed']).toBe(false)
    expect(rec['mainnet_ready']).toBe(false)

    // Confirm actual sender_hash hex and payload bytes do not leak
    const s_hash_hex = cap.sender_hash.toString('hex')
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(s_hash_hex)
    expect(serialised).not.toContain(PAYLOAD.toString('hex'))
  })
})
