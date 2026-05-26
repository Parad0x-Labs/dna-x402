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

// ---------------------------------------------------------------------------
// Cross-chain-lock primitives (mirrors crates/dark-cross-chain-lock)
//
// locker_hash        = SHA256("ccl-locker-v1"  || locker_secret)
// target_chain_hash  = SHA256("ccl-chain-v1"   || target_chain_bytes)
// asset_hash         = SHA256("ccl-asset-v1"   || asset_bytes)
// unlock_secret_hash = SHA256("ccl-unlock-v1"  || unlock_secret)
// lock_id            = SHA256("ccl-lock-v1"    || locker_hash || target_chain_hash || asset_hash
//                              || amount_u64le || unlock_secret_hash || nonce)
// unlock_hash        = SHA256("ccl-proof-v1"   || lock_id || unlock_secret_hash)
// ---------------------------------------------------------------------------

const PFX_LOCKER      = Buffer.from('ccl-locker-v1')
const PFX_CHAIN       = Buffer.from('ccl-chain-v1')
const PFX_ASSET       = Buffer.from('ccl-asset-v1')
const PFX_UNLOCK_SEC  = Buffer.from('ccl-unlock-v1')
const PFX_LOCK_ID     = Buffer.from('ccl-lock-v1')
const PFX_UNLOCK_HASH = Buffer.from('ccl-proof-v1')

function lockerHash(secret: Buffer): Buffer {
  return sha256(PFX_LOCKER, secret)
}

function targetChainHash(chainBytes: Buffer): Buffer {
  return sha256(PFX_CHAIN, chainBytes)
}

function assetHash(assetBytes: Buffer): Buffer {
  return sha256(PFX_ASSET, assetBytes)
}

function unlockSecretHash(secret: Buffer): Buffer {
  return sha256(PFX_UNLOCK_SEC, secret)
}

function computeLockId(
  lHash: Buffer,
  tHash: Buffer,
  aHash: Buffer,
  amount: bigint,
  ushHash: Buffer,
  nonce: Buffer,
): Buffer {
  return sha256(PFX_LOCK_ID, lHash, tHash, aHash, u64le(amount), ushHash, nonce)
}

function computeUnlockHash(lockId: Buffer, ushHash: Buffer): Buffer {
  return sha256(PFX_UNLOCK_HASH, lockId, ushHash)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
interface CrossChainLock {
  lock_id: Buffer
  locker_hash: Buffer
  target_chain_hash: Buffer
  asset_hash: Buffer
  amount: bigint
  unlock_secret_hash: Buffer
  released: boolean
  mainnet_ready: boolean
}

function createLock(
  lockerSecret: Buffer,
  targetChain: Buffer,
  asset: Buffer,
  amount: bigint,
  unlockSecret: Buffer,
  nonce: Buffer,
): CrossChainLock {
  const lHash   = lockerHash(lockerSecret)
  const tHash   = targetChainHash(targetChain)
  const aHash   = assetHash(asset)
  const ushHash = unlockSecretHash(unlockSecret)
  const lockId  = computeLockId(lHash, tHash, aHash, amount, ushHash, nonce)
  return {
    lock_id: lockId,
    locker_hash: lHash,
    target_chain_hash: tHash,
    asset_hash: aHash,
    amount,
    unlock_secret_hash: ushHash,
    released: false,
    mainnet_ready: false,
  }
}

function unlock(lock: CrossChainLock, unlockSecret: Buffer): Buffer {
  const ushHash = unlockSecretHash(unlockSecret)
  if (!ushHash.equals(lock.unlock_secret_hash)) throw new Error('WrongUnlockSecret')
  return computeUnlockHash(lock.lock_id, lock.unlock_secret_hash)
}

function lockPublicRecord(lock: CrossChainLock): object {
  return {
    lock_id: lock.lock_id.toString('hex'),
    target_chain_hash: lock.target_chain_hash.toString('hex'),
    asset_hash: lock.asset_hash.toString('hex'),
    amount: lock.amount.toString(),
    released: lock.released,
    mainnet_ready: lock.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null cross-chain-lock', () => {
  const LOCKER_SECRET  = Buffer.from('locker-secret-000000000000000000', 'utf8')
  const UNLOCK_SECRET  = Buffer.from('unlock-secret-000000000000000000', 'utf8')
  const CHAIN          = Buffer.from('ethereum')
  const ASSET          = Buffer.from('USDC')
  const AMOUNT         = 1_000n
  const NONCE          = Buffer.alloc(32).fill(0x01)

  it('lock_id computation is deterministic', () => {
    const lock1 = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    const lock2 = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    expect(lock1.lock_id.equals(lock2.lock_id)).toBe(true)

    // Manual recompute
    const lHash   = lockerHash(LOCKER_SECRET)
    const tHash   = targetChainHash(CHAIN)
    const aHash   = assetHash(ASSET)
    const ushHash = unlockSecretHash(UNLOCK_SECRET)
    const manual  = computeLockId(lHash, tHash, aHash, AMOUNT, ushHash, NONCE)
    expect(lock1.lock_id.equals(manual)).toBe(true)
  })

  it('unlock_hash computation is correct', () => {
    const lock      = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    const uHash     = unlock(lock, UNLOCK_SECRET)
    const manual    = computeUnlockHash(lock.lock_id, lock.unlock_secret_hash)
    expect(uHash.equals(manual)).toBe(true)
    expect(uHash.length).toBe(32)
  })

  it('wrong unlock secret → hash mismatch', () => {
    const lock         = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    const wrongSecret  = Buffer.alloc(32).fill(0xff)
    expect(() => unlock(lock, wrongSecret)).toThrow('WrongUnlockSecret')
  })

  it('public record hides locker_hash and unlock_secret_hash', () => {
    const lock = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    const rec  = lockPublicRecord(lock) as Record<string, unknown>

    expect(typeof rec['lock_id']).toBe('string')
    expect(rec['amount']).toBe(AMOUNT.toString())
    expect(rec['mainnet_ready']).toBe(false)

    expect(Object.keys(rec)).not.toContain('locker_hash')
    expect(Object.keys(rec)).not.toContain('unlock_secret_hash')

    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(lock.locker_hash.toString('hex'))
    expect(serialised).not.toContain(lock.unlock_secret_hash.toString('hex'))
  })

  it('different amounts → different lock_ids', () => {
    const lock1 = createLock(LOCKER_SECRET, CHAIN, ASSET, 500n,  UNLOCK_SECRET, NONCE)
    const lock2 = createLock(LOCKER_SECRET, CHAIN, ASSET, 1_000n, UNLOCK_SECRET, NONCE)
    expect(lock1.lock_id.equals(lock2.lock_id)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const lock = createLock(LOCKER_SECRET, CHAIN, ASSET, AMOUNT, UNLOCK_SECRET, NONCE)
    expect(lock.mainnet_ready).toBe(false)
    const rec = lockPublicRecord(lock) as Record<string, unknown>
    expect(rec['mainnet_ready']).toBe(false)
  })
})
