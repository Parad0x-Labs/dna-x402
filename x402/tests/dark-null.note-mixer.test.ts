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
// Note-mixer primitives (mirrors crates/dark-note-mixer/src/lib.rs)
//
// asset_tag          = SHA256("asset-tag-v1"   || asset_id_bytes)
// note_commitment    = SHA256("mix-note-v1"     || amount_le[8] || asset_tag[32] || secret[32])
// pool_root          = SHA256("mix-pool-v1"     || xor_fold(commitments))
// nullifier          = SHA256("mix-null-v1"     || note_commitment || pool_root)
// ---------------------------------------------------------------------------

function asset_tag(asset_id_bytes: Buffer): Buffer {
  return sha256(Buffer.from('asset-tag-v1'), asset_id_bytes)
}

function note_commitment(amount: bigint, asset_id: Buffer, secret: Buffer): Buffer {
  if (amount === 0n) throw new Error('ZeroAmount')
  const tag = asset_tag(asset_id)
  return sha256(Buffer.from('mix-note-v1'), u64le(amount), tag, secret)
}

function xor_fold(commitments: Buffer[]): Buffer {
  let acc = Buffer.alloc(32, 0)
  for (const c of commitments) acc = xor(acc, c)
  return acc
}

function pool_root(commitments: Buffer[]): Buffer {
  return sha256(Buffer.from('mix-pool-v1'), xor_fold(commitments))
}

function make_nullifier(commitment: Buffer, root: Buffer): Buffer {
  return sha256(Buffer.from('mix-null-v1'), commitment, root)
}

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------
interface NoteMixer {
  commitments: Buffer[]
  spent_nullifiers: Buffer[]
}

function create_pool(): NoteMixer {
  return { commitments: [], spent_nullifiers: [] }
}

function deposit(pool: NoteMixer, commitment: Buffer): void {
  pool.commitments.push(Buffer.from(commitment))
}

function withdraw(pool: NoteMixer, commitment: Buffer, nullifier: Buffer): void {
  const root = pool_root(pool.commitments)
  // Check commitment is in pool
  const inPool = pool.commitments.some(c => c.equals(commitment))
  if (!inPool) throw new Error('CommitmentNotInPool')
  // Check double-spend
  if (pool.spent_nullifiers.some(n => n.equals(nullifier))) throw new Error('AlreadySpent')
  // Verify nullifier = SHA256("mix-null-v1" || commitment || pool_root)
  const expected = make_nullifier(commitment, root)
  if (!expected.equals(nullifier)) throw new Error('InvalidNullifier')
  pool.spent_nullifiers.push(Buffer.from(nullifier))
}

function public_record(pool: NoteMixer): object {
  return {
    pool_size: pool.commitments.length,
    // total_committed is hidden
    total_committed: null,
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null note-mixer', () => {
  const ASSET_ID = Buffer.from('usdc-mint-0000000000000000000000000000', 'utf8').slice(0, 32)
  const SECRET_A = Buffer.alloc(32).fill(0xa1)
  const SECRET_B = Buffer.alloc(32).fill(0xb2)
  const AMOUNT_A = 1_000_000n
  const AMOUNT_B = 5_000_000n

  it('deposit and withdraw roundtrip', () => {
    const pool = create_pool()
    const cm = note_commitment(AMOUNT_A, ASSET_ID, SECRET_A)
    deposit(pool, cm)

    const root = pool_root(pool.commitments)
    const null_a = make_nullifier(cm, root)
    expect(() => withdraw(pool, cm, null_a)).not.toThrow()
    expect(pool.spent_nullifiers.length).toBe(1)
  })

  it('double spend detected', () => {
    const pool = create_pool()
    const cm = note_commitment(AMOUNT_A, ASSET_ID, SECRET_A)
    deposit(pool, cm)

    const root = pool_root(pool.commitments)
    const null_a = make_nullifier(cm, root)
    withdraw(pool, cm, null_a)

    expect(() => withdraw(pool, cm, null_a)).toThrow('AlreadySpent')
  })

  it('commitment not in pool rejected', () => {
    const pool = create_pool()
    const cm_a = note_commitment(AMOUNT_A, ASSET_ID, SECRET_A)
    const cm_b = note_commitment(AMOUNT_B, ASSET_ID, SECRET_B)
    deposit(pool, cm_a)

    // Build nullifier with a root that includes only cm_a
    const root = pool_root(pool.commitments)
    const null_b = make_nullifier(cm_b, root)

    // cm_b is not in pool → rejected
    expect(() => withdraw(pool, cm_b, null_b)).toThrow('CommitmentNotInPool')
  })

  it('zero amount rejected', () => {
    expect(() => note_commitment(0n, ASSET_ID, SECRET_A)).toThrow('ZeroAmount')
  })

  it('pool root changes on deposit', () => {
    const pool = create_pool()
    const root0 = pool_root(pool.commitments)

    const cm = note_commitment(AMOUNT_A, ASSET_ID, SECRET_A)
    deposit(pool, cm)
    const root1 = pool_root(pool.commitments)

    expect(root0.equals(root1)).toBe(false)

    // Second deposit changes root again
    const cm2 = note_commitment(AMOUNT_B, ASSET_ID, SECRET_B)
    deposit(pool, cm2)
    const root2 = pool_root(pool.commitments)
    expect(root1.equals(root2)).toBe(false)
  })

  it('public record hides total_committed, mainnet_ready is false', () => {
    const pool = create_pool()
    const cm = note_commitment(AMOUNT_A, ASSET_ID, SECRET_A)
    deposit(pool, cm)

    const rec = public_record(pool) as Record<string, unknown>
    expect(rec['total_committed']).toBeNull()
    expect(rec['pool_size']).toBe(1)
    expect(rec['mainnet_ready']).toBe(false)

    // Ensure the actual amount value does not appear
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(AMOUNT_A.toString())
  })
})
