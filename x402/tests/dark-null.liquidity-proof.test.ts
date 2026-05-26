import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u8(n: number): Buffer { return Buffer.from([n]) }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// ---------------------------------------------------------------------------
// LiquidityProof (mirrors crates/dark-liquidity-proof/src/lib.rs)
//
// reserve_commitment = SHA256("reserve-v1" || actual_reserve_le[8] || blinding[32])
// proof_hash         = SHA256("liq-proof-v1" || pool_id[32]
//                              || reserve_commitment[32] || minimum_liquidity_le[8])
//
// verify: recompute reserve_commitment from (actual_reserve, blinding),
//         check commitment matches, then check actual_reserve >= minimum_liquidity
//
// Errors: InsufficientLiquidity, ZeroMinimum
// ---------------------------------------------------------------------------

interface LiquidityStatement {
  pool_id: Buffer           // 32 bytes
  reserve_commitment: Buffer // 32 bytes — hides actual_reserve
  minimum_liquidity: bigint
  proof_hash: Buffer        // 32 bytes
}

function reserveCommitment(actual_reserve: bigint, blinding: Buffer): Buffer {
  if (blinding.length !== 32) throw new Error('blinding must be 32 bytes')
  return sha256(Buffer.from('reserve-v1'), u64le(actual_reserve), blinding)
}

function createProof(
  pool_id: Buffer,
  actual_reserve: bigint,
  blinding: Buffer,
  minimum_liquidity: bigint,
): LiquidityStatement {
  if (minimum_liquidity === 0n) throw new Error('ZeroMinimum')
  if (actual_reserve < minimum_liquidity) throw new Error('InsufficientLiquidity')

  const commitment = reserveCommitment(actual_reserve, blinding)
  const proof_hash = sha256(
    Buffer.from('liq-proof-v1'),
    pool_id,
    commitment,
    u64le(minimum_liquidity),
  )
  return { pool_id: Buffer.from(pool_id), reserve_commitment: commitment, minimum_liquidity, proof_hash }
}

function verifyProof(
  stmt: LiquidityStatement,
  actual_reserve: bigint,
  blinding: Buffer,
): boolean {
  const recomputed = reserveCommitment(actual_reserve, blinding)
  if (!recomputed.equals(stmt.reserve_commitment)) return false
  if (actual_reserve < stmt.minimum_liquidity) return false
  return true
}

function publicRecord(stmt: LiquidityStatement): object {
  return {
    pool_id: stmt.pool_id.toString('hex'),
    reserve_commitment: stmt.reserve_commitment.toString('hex'),
    minimum_liquidity: stmt.minimum_liquidity.toString(),
    proof_hash: stmt.proof_hash.toString('hex'),
    // actual_reserve is intentionally absent — kept private
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null liquidity-proof', () => {
  const POOL_ID  = Buffer.alloc(32).fill(0x1a)
  const BLINDING = Buffer.alloc(32).fill(0x5f)

  it('sufficient liquidity: proof created and verify passes', () => {
    const stmt = createProof(POOL_ID, 1_000_000n, BLINDING, 500_000n)
    expect(stmt.proof_hash.length).toBe(32)
    expect(verifyProof(stmt, 1_000_000n, BLINDING)).toBe(true)
  })

  it('insufficient liquidity is rejected at proof creation', () => {
    expect(() => createProof(POOL_ID, 300_000n, BLINDING, 500_000n))
      .toThrow('InsufficientLiquidity')
  })

  it('wrong blinding fails verify', () => {
    const stmt = createProof(POOL_ID, 1_000_000n, BLINDING, 500_000n)
    const wrongBlinding = Buffer.alloc(32).fill(0xff)
    expect(verifyProof(stmt, 1_000_000n, wrongBlinding)).toBe(false)
  })

  it('zero minimum is rejected', () => {
    expect(() => createProof(POOL_ID, 1_000_000n, BLINDING, 0n))
      .toThrow('ZeroMinimum')
  })

  it('public record hides actual_reserve — not present in JSON', () => {
    const actual = 9_876_543n
    const stmt = createProof(POOL_ID, actual, BLINDING, 1_000n)
    const rec = publicRecord(stmt) as Record<string, unknown>

    // actual_reserve must not appear as a key
    expect('actual_reserve' in rec).toBe(false)

    // The raw decimal string for actual_reserve must not leak in the serialised record
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain('9876543')
    expect(rec['mainnet_ready']).toBe(false)
  })

  it('proof_hash is deterministic for the same inputs', () => {
    const s1 = createProof(POOL_ID, 2_000_000n, BLINDING, 1_000_000n)
    const s2 = createProof(POOL_ID, 2_000_000n, BLINDING, 1_000_000n)
    expect(s1.proof_hash.equals(s2.proof_hash)).toBe(true)
    expect(s1.reserve_commitment.equals(s2.reserve_commitment)).toBe(true)
  })
})
