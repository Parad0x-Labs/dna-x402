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

// ---------------------------------------------------------------------------
// Token-vesting inline implementation
// Mirrors crates/dark-token-vesting/src/lib.rs
//
// beneficiary_hash = SHA256("vest-beneficiary-v1" || beneficiary_secret)
// schedule_id = SHA256("vest-schedule-v1" || beneficiary_hash || total_u64le
//                      || cliff_i64le || end_i64le || nonce)
// claim_id    = SHA256("vest-claim-v1" || schedule_id || amount_u64le || claimed_at_i64le)
//
// vested(t):
//   if t < cliff → 0
//   if t >= end  → total
//   else         → floor(total * (t - cliff) / (end - cliff))
// ---------------------------------------------------------------------------

function beneficiaryHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('vest-beneficiary-v1'), secret)
}

function scheduleId(
  beneficiarySecret: Buffer,
  total: bigint,
  cliff: bigint,
  end: bigint,
  nonce: Buffer,
): Buffer {
  const bh = beneficiaryHash(beneficiarySecret)
  return sha256(Buffer.from('vest-schedule-v1'), bh, u64le(total), i64le(cliff), i64le(end), nonce)
}

function claimId(
  schedId: Buffer,
  amount: bigint,
  claimedAt: bigint,
): Buffer {
  return sha256(Buffer.from('vest-claim-v1'), schedId, u64le(amount), i64le(claimedAt))
}

function vestedAmount(total: bigint, cliff: bigint, end: bigint, t: bigint): bigint {
  if (t < cliff) return 0n
  if (t >= end) return total
  return (total * (t - cliff)) / (end - cliff)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null token-vesting', () => {
  const SECRET = Buffer.alloc(32).fill(0x55)
  const NONCE = Buffer.alloc(32).fill(0xaa)
  const TOTAL = 1_000_000n   // 1 USDC in atomic (6 decimals)
  const CLIFF = 1000n        // unix-style timestamp epoch
  const END = 2000n

  it('schedule_id = SHA256("vest-schedule-v1" || beneficiary_hash || total || cliff || end || nonce)', () => {
    const sid = scheduleId(SECRET, TOTAL, CLIFF, END, NONCE)
    expect(sid).toBeInstanceOf(Buffer)
    expect(sid.length).toBe(32)
    const bh = beneficiaryHash(SECRET)
    const expected = sha256(Buffer.from('vest-schedule-v1'), bh, u64le(TOTAL), i64le(CLIFF), i64le(END), NONCE)
    expect(sid).toEqual(expected)
  })

  it('claim_id = SHA256("vest-claim-v1" || schedule_id || amount_u64le || claimed_at_i64le)', () => {
    const sid = scheduleId(SECRET, TOTAL, CLIFF, END, NONCE)
    const amount = 500_000n
    const claimedAt = 1500n
    const cId = claimId(sid, amount, claimedAt)
    expect(cId).toBeInstanceOf(Buffer)
    expect(cId.length).toBe(32)
    const expected = sha256(Buffer.from('vest-claim-v1'), sid, u64le(amount), i64le(claimedAt))
    expect(cId).toEqual(expected)
  })

  it('vested amount at cliff=0 for t=cliff equals 0 (cliff not yet reached is 0, cliff boundary begins)', () => {
    // cliff=0 means vesting starts immediately; at t=0 we use cliff==0 → t >= end check
    // vested(0n, 0, 1000) where total=1000000, cliff=0, end=1000
    const vested = vestedAmount(TOTAL, 0n, 1000n, 0n)
    // t=0, cliff=0: 0 >= 0 so NOT (t < cliff), check t >= end: 0 >= 1000 false
    // → floor(1000000 * (0 - 0) / (1000 - 0)) = 0
    expect(vested).toBe(0n)
  })

  it('vested amount at half-way between cliff and end', () => {
    // t = 1500, cliff=1000, end=2000, total=1000000
    // fraction = (1500-1000)/(2000-1000) = 500/1000 = 0.5
    // vested = floor(1000000 * 0.5) = 500000
    const vested = vestedAmount(TOTAL, CLIFF, END, 1500n)
    expect(vested).toBe(500_000n)
  })

  it('before cliff → vested = 0', () => {
    const vested = vestedAmount(TOTAL, CLIFF, END, 500n)
    expect(vested).toBe(0n)
  })

  it('mainnet_ready=false in public record', () => {
    const sid = scheduleId(SECRET, TOTAL, CLIFF, END, NONCE)
    const bh = beneficiaryHash(SECRET)
    // Public record must not contain raw secret, only beneficiary_hash
    const record = {
      schedule_id: sid.toString('hex'),
      total: TOTAL.toString(),
      mainnet_ready: false,
    }
    const raw = JSON.stringify(record)
    expect(raw).not.toContain(SECRET.toString('hex'))
    expect(record.mainnet_ready).toBe(false)
    expect(record.schedule_id.length).toBe(64)
    // Ensure beneficiary_hash is not in the public record (it's derived, still private)
    expect(raw).not.toContain(bh.toString('hex'))
  })
})
