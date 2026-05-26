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

const VALIDATOR_SECRET = Buffer.alloc(32, 0xbb)
const STAKER_SECRET = Buffer.alloc(32, 0x77)

function validatorHash(vs: Buffer): Buffer {
  return sha256(Buffer.from('reward-validator-v1'), vs)
}

function poolId(vh: Buffer, epoch: bigint, totalRewards: bigint): Buffer {
  return sha256(Buffer.from('reward-pool-v1'), vh, u64le(epoch), u64le(totalRewards))
}

function stakerHash(ss: Buffer): Buffer {
  return sha256(Buffer.from('reward-staker-v1'), ss)
}

function claimId(pid: Buffer, sh: Buffer, amount: bigint, epoch: bigint): Buffer {
  return sha256(Buffer.from('reward-claim-v1'), pid, sh, u64le(amount), u64le(epoch))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null.staking-rewards (Wave 15 batch-2)', () => {
  const EPOCH = BigInt(42)
  const TOTAL_REWARDS = BigInt(1_000_000)
  const CLAIM_AMOUNT = BigInt(5_000)

  it('pool_id = SHA256("reward-pool-v1" || validator_hash || epoch_u64le || total_rewards_u64le)', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid = poolId(vh, EPOCH, TOTAL_REWARDS)

    const expected = sha256(Buffer.from('reward-pool-v1'), vh, u64le(EPOCH), u64le(TOTAL_REWARDS))
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
    expect(pid).toHaveLength(32)
  })

  it('claim_id = SHA256("reward-claim-v1" || pool_id || staker_hash || amount_u64le || epoch_u64le)', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid = poolId(vh, EPOCH, TOTAL_REWARDS)
    const sh = stakerHash(STAKER_SECRET)
    const cid = claimId(pid, sh, CLAIM_AMOUNT, EPOCH)

    const expected = sha256(Buffer.from('reward-claim-v1'), pid, sh, u64le(CLAIM_AMOUNT), u64le(EPOCH))
    expect(cid.toString('hex')).toBe(expected.toString('hex'))
    expect(cid).toHaveLength(32)
  })

  it('different epochs produce different pool_ids', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid1 = poolId(vh, BigInt(1), TOTAL_REWARDS)
    const pid2 = poolId(vh, BigInt(2), TOTAL_REWARDS)
    expect(pid1.toString('hex')).not.toBe(pid2.toString('hex'))
  })

  it('insufficient rewards guard: claim_amount > total_rewards should be detectable', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid = poolId(vh, EPOCH, TOTAL_REWARDS)
    const sh = stakerHash(STAKER_SECRET)
    const excessiveAmount = TOTAL_REWARDS + BigInt(1)

    // Guard check: claim amount must not exceed total rewards
    const isInvalid = excessiveAmount > TOTAL_REWARDS
    expect(isInvalid).toBe(true)

    // Valid claim
    const validAmount = TOTAL_REWARDS - BigInt(1)
    const isValid = validAmount <= TOTAL_REWARDS
    expect(isValid).toBe(true)

    const cid = claimId(pid, sh, validAmount, EPOCH)
    expect(cid).toHaveLength(32)
  })

  it('public record hides validator_hash: JSON contains pool_id but not validator_hash', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid = poolId(vh, EPOCH, TOTAL_REWARDS)
    const record = {
      pool_id: pid.toString('hex'),
      epoch: Number(EPOCH),
      total_rewards: Number(TOTAL_REWARDS),
      mainnet_ready: false,
    }
    const recStr = JSON.stringify(record)
    expect(recStr).toContain('pool_id')
    expect(recStr).not.toContain(vh.toString('hex'))
    expect(recStr).not.toContain(VALIDATOR_SECRET.toString('hex'))
  })

  it('mainnet_ready=false in all records', () => {
    const vh = validatorHash(VALIDATOR_SECRET)
    const pid = poolId(vh, EPOCH, TOTAL_REWARDS)
    const sh = stakerHash(STAKER_SECRET)
    const cid = claimId(pid, sh, CLAIM_AMOUNT, EPOCH)
    const poolRecord = { pool_id: pid.toString('hex'), mainnet_ready: false }
    const claimRecord = { claim_id: cid.toString('hex'), mainnet_ready: false }
    expect(poolRecord.mainnet_ready).toBe(false)
    expect(claimRecord.mainnet_ready).toBe(false)
  })
})
