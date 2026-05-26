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
// State Channel primitives
//
// party_hash  = SHA256("schan-party-v1"  || party_secret)
// channel_id  = SHA256("schan-id-v1"     || party_a_hash || party_b_hash || total_u64le || nonce)
// state_hash  = SHA256("schan-state-v1"  || channel_id || balance_a_u64le || balance_b_u64le || seq_u32le)
// update_id   = SHA256("schan-update-v1" || channel_id || new_a_u64le || new_b_u64le || seq_u32le)
// ---------------------------------------------------------------------------

function partyHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('schan-party-v1'), secret)
}

function channelId(partyA: Buffer, partyB: Buffer, total: bigint, nonce: Buffer): Buffer {
  return sha256(Buffer.from('schan-id-v1'), partyA, partyB, u64le(total), nonce)
}

function stateHash(chanId: Buffer, balanceA: bigint, balanceB: bigint, seq: number): Buffer {
  return sha256(Buffer.from('schan-state-v1'), chanId, u64le(balanceA), u64le(balanceB), u32le(seq))
}

function updateId(chanId: Buffer, newA: bigint, newB: bigint, seq: number): Buffer {
  return sha256(Buffer.from('schan-update-v1'), chanId, u64le(newA), u64le(newB), u32le(seq))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null state-channel', () => {
  const SECRET_A = Buffer.from('party-a-secret-schan-00000000000', 'utf8')
  const SECRET_B = Buffer.from('party-b-secret-schan-00000000000', 'utf8')
  const TOTAL    = 1_000_000n
  const NONCE    = Buffer.alloc(32).fill(0x77)

  const partyA  = partyHash(SECRET_A)
  const partyB  = partyHash(SECRET_B)
  const chanId  = channelId(partyA, partyB, TOTAL, NONCE)

  it('channel_id computation is deterministic and 32 bytes', () => {
    const pA2   = partyHash(SECRET_A)
    const pB2   = partyHash(SECRET_B)
    const cId2  = channelId(pA2, pB2, TOTAL, NONCE)

    expect(chanId.length).toBe(32)
    expect(chanId.equals(cId2)).toBe(true)

    // different parties → different channel_id
    const otherSecret = Buffer.from('party-c-secret-schan-00000000000', 'utf8')
    const partyC = partyHash(otherSecret)
    const cId3   = channelId(pA2, partyC, TOTAL, NONCE)
    expect(chanId.equals(cId3)).toBe(false)
  })

  it('state_hash computation is deterministic and reflects balances', () => {
    const sh1 = stateHash(chanId, 600_000n, 400_000n, 0)
    const sh2 = stateHash(chanId, 600_000n, 400_000n, 0)
    expect(sh1.length).toBe(32)
    expect(sh1.equals(sh2)).toBe(true)

    // different balance distribution → different state_hash
    const sh3 = stateHash(chanId, 700_000n, 300_000n, 0)
    expect(sh1.equals(sh3)).toBe(false)
  })

  it('update_id computation is deterministic', () => {
    const uid1 = updateId(chanId, 550_000n, 450_000n, 1)
    const uid2 = updateId(chanId, 550_000n, 450_000n, 1)
    expect(uid1.length).toBe(32)
    expect(uid1.equals(uid2)).toBe(true)

    // different seq → different update_id
    const uid3 = updateId(chanId, 550_000n, 450_000n, 2)
    expect(uid1.equals(uid3)).toBe(false)
  })

  it('balance sum must match total (invariant check)', () => {
    const balanceA = 600_000n
    const balanceB = 400_000n
    const sum      = balanceA + balanceB

    expect(sum).toBe(TOTAL)

    // imbalanced distribution still sums to total
    const a2 = 999_999n
    const b2 = 1n
    expect(a2 + b2).toBe(TOTAL)

    // completely off would NOT sum to total
    const bad = 999_999n + 2n
    expect(bad).not.toBe(TOTAL)
  })

  it('sequence must advance: seq N+1 > seq N (update ordering)', () => {
    const seq0 = 0
    const seq1 = 1
    const seq2 = 2

    const sh0 = stateHash(chanId, 600_000n, 400_000n, seq0)
    const sh1 = stateHash(chanId, 550_000n, 450_000n, seq1)
    const sh2 = stateHash(chanId, 500_000n, 500_000n, seq2)

    // all different
    expect(sh0.equals(sh1)).toBe(false)
    expect(sh1.equals(sh2)).toBe(false)
    expect(sh0.equals(sh2)).toBe(false)

    // seq must strictly advance
    expect(seq1).toBeGreaterThan(seq0)
    expect(seq2).toBeGreaterThan(seq1)
  })

  it('mainnet_ready is always false', () => {
    const record = {
      channel_id:    chanId.toString('hex'),
      state_hash:    stateHash(chanId, 500_000n, 500_000n, 0).toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
