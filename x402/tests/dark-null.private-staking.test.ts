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

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Private-staking primitives (mirrors crates/dark-private-staking)
//
// staker_hash   = SHA256("stake-staker-v1"   || staker_secret)
// rewards_hash  = SHA256("stake-rewards-v1"  || staker_hash || amount_u64le || locked_until_i64le)
// position_id   = SHA256("stake-pos-v1"      || staker_hash || amount_u64le || locked_until_i64le || nonce)
// ---------------------------------------------------------------------------

const PFX_STAKER   = Buffer.from('stake-staker-v1')
const PFX_REWARDS  = Buffer.from('stake-rewards-v1')
const PFX_POSITION = Buffer.from('stake-pos-v1')

function stakerHash(secret: Buffer): Buffer {
  return sha256(PFX_STAKER, secret)
}

function rewardsHash(sHash: Buffer, amount: bigint, lockedUntil: bigint): Buffer {
  return sha256(PFX_REWARDS, sHash, u64le(amount), i64le(lockedUntil))
}

function positionId(sHash: Buffer, amount: bigint, lockedUntil: bigint, nonce: Buffer): Buffer {
  return sha256(PFX_POSITION, sHash, u64le(amount), i64le(lockedUntil), nonce)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
interface StakePosition {
  position_id: Buffer
  staker_hash: Buffer
  amount: bigint
  locked_until_unix: bigint
  rewards_hash: Buffer
  unstaked: boolean
  mainnet_ready: boolean
}

function createPosition(
  stakerSecret: Buffer,
  amount: bigint,
  lockedUntil: bigint,
  nonce: Buffer,
): StakePosition {
  if (stakerSecret.every(b => b === 0)) throw new Error('ZeroStakerSecret')
  if (amount === 0n) throw new Error('ZeroAmount')
  const sHash = stakerHash(stakerSecret)
  return {
    position_id: positionId(sHash, amount, lockedUntil, nonce),
    staker_hash: sHash,
    amount,
    locked_until_unix: lockedUntil,
    rewards_hash: rewardsHash(sHash, amount, lockedUntil),
    unstaked: false,
    mainnet_ready: false,
  }
}

function unstake(position: StakePosition, currentUnix: bigint): void {
  if (currentUnix < position.locked_until_unix) {
    throw new Error(`NotUnlocked: current=${currentUnix} locked_until=${position.locked_until_unix}`)
  }
}

function positionPublicRecord(pos: StakePosition): object {
  return {
    position_id: pos.position_id.toString('hex'),
    amount: pos.amount.toString(),
    locked_until_unix: pos.locked_until_unix.toString(),
    unstaked: pos.unstaked,
    mainnet_ready: pos.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-staking', () => {
  const SECRET  = Buffer.from('staker-secret-000000000000000000', 'utf8')
  const NONCE   = Buffer.alloc(32).fill(0xaa)
  const AMOUNT  = 1_000n
  const LOCKED  = 100n

  it('position_id computation is deterministic', () => {
    const pos1 = createPosition(SECRET, AMOUNT, LOCKED, NONCE)
    const pos2 = createPosition(SECRET, AMOUNT, LOCKED, NONCE)
    expect(pos1.position_id.equals(pos2.position_id)).toBe(true)

    // Manual recompute
    const sHash  = stakerHash(SECRET)
    const manual = positionId(sHash, AMOUNT, LOCKED, NONCE)
    expect(pos1.position_id.equals(manual)).toBe(true)
  })

  it('rewards_hash computation is deterministic', () => {
    const pos    = createPosition(SECRET, AMOUNT, LOCKED, NONCE)
    const manual = rewardsHash(pos.staker_hash, AMOUNT, LOCKED)
    expect(pos.rewards_hash.equals(manual)).toBe(true)

    // Different amount → different rewards_hash
    const other = rewardsHash(pos.staker_hash, 2_000n, LOCKED)
    expect(pos.rewards_hash.equals(other)).toBe(false)
  })

  it('unstake before lock_until → error', () => {
    const pos = createPosition(SECRET, AMOUNT, 1_000n, NONCE)
    // current (500) < locked_until (1000)
    expect(() => unstake(pos, 500n)).toThrow('NotUnlocked')
    // exactly at boundary → ok
    expect(() => unstake(pos, 1_000n)).not.toThrow()
  })

  it('public record hides staker_hash', () => {
    const pos = createPosition(SECRET, AMOUNT, LOCKED, NONCE)
    const rec = positionPublicRecord(pos) as Record<string, unknown>

    expect(typeof rec['position_id']).toBe('string')
    expect(rec['amount']).toBe(AMOUNT.toString())
    expect(rec['mainnet_ready']).toBe(false)

    // staker_hash must not appear in the record
    expect(Object.keys(rec)).not.toContain('staker_hash')
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(pos.staker_hash.toString('hex'))
  })

  it('different amounts → different position_ids', () => {
    const pos1 = createPosition(SECRET, 1_000n, LOCKED, NONCE)
    const pos2 = createPosition(SECRET, 2_000n, LOCKED, NONCE)
    expect(pos1.position_id.equals(pos2.position_id)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const pos = createPosition(SECRET, AMOUNT, LOCKED, NONCE)
    expect(pos.mainnet_ready).toBe(false)
    const rec = positionPublicRecord(pos) as Record<string, unknown>
    expect(rec['mainnet_ready']).toBe(false)
  })
})
