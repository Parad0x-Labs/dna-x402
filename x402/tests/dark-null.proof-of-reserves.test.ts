/**
 * Proof of reserves tests — TypeScript mirror of
 * crates/dark-proof-of-reserves/src/lib.rs
 *
 * Algorithms (pure Node.js crypto):
 *   leaf_hash = SHA256("reserve-leaf-v1" || account_id[32] || balance_le[8] || nonce[32])
 *
 * Root accumulation (mirrors Rust exactly):
 *   pool starts with root = Buffer.alloc(32, 0)
 *   add_leaf: XOR leaf_hash into root byte-by-byte (root IS the XOR accumulator — no
 *             secondary SHA256 pass is performed; see Rust add_leaf fn lines 90-98)
 *
 * prove_inclusion: scan leaves array for matching leaf_hash
 *
 * Note: the Rust create_leaf returns Err(ZeroBalance) when balance == 0.
 * The TS helpers below allow zero balance so test 4 can confirm the hash
 * is still computed correctly (the TS layer does not replicate the guard).
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Core primitive
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Leaf construction
// ---------------------------------------------------------------------------

function createLeaf(accountId: Buffer, balance: bigint, nonce: Buffer): Buffer {
  if (accountId.length !== 32) throw new Error('account_id must be 32 bytes')
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes')

  const balanceBuf = Buffer.allocUnsafe(8)
  balanceBuf.writeBigUInt64LE(balance)

  return sha256(Buffer.from('reserve-leaf-v1'), accountId, balanceBuf, nonce)
}

// ---------------------------------------------------------------------------
// Pool / tree
// ---------------------------------------------------------------------------

interface ReservesPool {
  root: Buffer // XOR accumulator — mirrors Rust ReservesTree.root
  leafCount: number
  leaves: Buffer[] // stored leaf hashes for prove_inclusion scan
}

function newReservesPool(): ReservesPool {
  return {
    root: Buffer.alloc(32, 0),
    leafCount: 0,
    leaves: [],
  }
}

function addLeaf(pool: ReservesPool, leafHash: Buffer): void {
  // XOR accumulate byte-by-byte, identical to Rust add_leaf
  for (let i = 0; i < 32; i++) {
    pool.root[i] ^= leafHash[i]
  }
  pool.leafCount++
  pool.leaves.push(Buffer.from(leafHash))
}

/**
 * Returns true if leafHash is present in the pool, false otherwise.
 * Mirrors Rust prove_inclusion (returns LeafNotFound when absent).
 */
function proveInclusion(pool: ReservesPool, leafHash: Buffer): boolean {
  return pool.leaves.some((l) => l.equals(leafHash))
}

function reservesPublicRecord(pool: ReservesPool): object {
  return {
    root_hex: pool.root.toString('hex'),
    leaf_count: pool.leafCount,
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function sampleId(seed: number): Buffer {
  return Buffer.alloc(32, seed)
}

function sampleNonce(seed: number): Buffer {
  return Buffer.alloc(32, seed ^ 0xab)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null proof of reserves', () => {
  it('happy path: add leaves and prove inclusion', () => {
    const pool = newReservesPool()

    const leaf1 = createLeaf(sampleId(1), 1_000n, sampleNonce(1))
    const leaf2 = createLeaf(sampleId(2), 2_000n, sampleNonce(2))
    const leaf3 = createLeaf(sampleId(3), 3_000n, sampleNonce(3))

    addLeaf(pool, leaf1)
    addLeaf(pool, leaf2)
    addLeaf(pool, leaf3)

    expect(pool.leafCount).toBe(3)

    // Each leaf must prove inclusion
    expect(proveInclusion(pool, leaf1)).toBe(true)
    expect(proveInclusion(pool, leaf2)).toBe(true)
    expect(proveInclusion(pool, leaf3)).toBe(true)
  })

  it('leaf not found: unknown leaf rejected', () => {
    const pool = newReservesPool()

    const leaf = createLeaf(sampleId(10), 500n, sampleNonce(10))
    addLeaf(pool, leaf)

    const unknownLeaf = Buffer.alloc(32, 0xff)
    expect(proveInclusion(pool, unknownLeaf)).toBe(false)
  })

  it('root changes on each leaf addition', () => {
    const pool = newReservesPool()
    const root0 = Buffer.from(pool.root)

    const leaf1 = createLeaf(sampleId(5), 100n, sampleNonce(5))
    addLeaf(pool, leaf1)
    const root1 = Buffer.from(pool.root)
    expect(root1.equals(root0)).toBe(false)

    const leaf2 = createLeaf(sampleId(6), 200n, sampleNonce(6))
    addLeaf(pool, leaf2)
    const root2 = Buffer.from(pool.root)
    expect(root2.equals(root1)).toBe(false)

    const leaf3 = createLeaf(sampleId(7), 300n, sampleNonce(7))
    addLeaf(pool, leaf3)
    const root3 = Buffer.from(pool.root)
    expect(root3.equals(root2)).toBe(false)

    // All three intermediate roots are distinct
    expect(root1.equals(root2)).toBe(false)
    expect(root2.equals(root3)).toBe(false)
  })

  it('zero balance: leaf hash still computed correctly', () => {
    // Note: Rust create_leaf returns Err(ZeroBalance) for balance == 0.
    // The TS helper does not replicate that guard; instead we verify that
    // balance=0n still hashes deterministically without throwing.
    const accountId = sampleId(99)
    const nonce = sampleNonce(99)

    const leafA = createLeaf(accountId, 0n, nonce)
    const leafB = createLeaf(accountId, 0n, nonce)

    // Same inputs → same hash (deterministic)
    expect(leafA.equals(leafB)).toBe(true)
    // Hash is 32 bytes of non-zero content
    expect(leafA.length).toBe(32)
    expect(leafA.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('leaf hash sensitive to all fields', () => {
    const base = createLeaf(sampleId(1), 1_000n, sampleNonce(1))

    // Change account_id only
    const diffAccount = createLeaf(sampleId(2), 1_000n, sampleNonce(1))
    expect(diffAccount.equals(base)).toBe(false)

    // Change balance only
    const diffBalance = createLeaf(sampleId(1), 2_000n, sampleNonce(1))
    expect(diffBalance.equals(base)).toBe(false)

    // Change nonce only
    const diffNonce = createLeaf(sampleId(1), 1_000n, sampleNonce(2))
    expect(diffNonce.equals(base)).toBe(false)
  })

  it('public record shape', () => {
    const pool = newReservesPool()

    const leaf1 = createLeaf(sampleId(20), 99_999n, sampleNonce(20))
    const leaf2 = createLeaf(sampleId(21), 12_345n, sampleNonce(21))
    addLeaf(pool, leaf1)
    addLeaf(pool, leaf2)

    const record = reservesPublicRecord(pool) as Record<string, unknown>

    // Required public fields
    expect(typeof record.root_hex).toBe('string')
    expect((record.root_hex as string).length).toBe(64) // 32 bytes hex
    expect(record.leaf_count).toBe(2)

    // Must NOT expose total_balance or individual balances
    const json = JSON.stringify(record)
    expect(json).not.toContain('99999')
    expect(json).not.toContain('12345')
    expect(json).not.toContain('total_balance')
    expect(json).not.toContain('total_committed')
  })
})
