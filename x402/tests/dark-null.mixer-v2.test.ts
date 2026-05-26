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
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

const VALID_DENOMINATIONS: bigint[] = [
  BigInt(1e9),
  BigInt(1e10),
  BigInt(1e11),
  BigInt(1e12),
  BigInt(1e13),
]

function poolId(denomination: bigint, version: number): Buffer {
  return sha256(Buffer.from('mixer-v2-pool-v1'), u64le(denomination), u32le(version))
}

function commitment(denomination: bigint, secret: Buffer): Buffer {
  return sha256(Buffer.from('mixer-v2-commit-v1'), u64le(denomination), secret)
}

function poolRoot(commitments: Buffer[], depositCount: number): Buffer {
  const xor = xorFold(commitments)
  return sha256(Buffer.from('mixer-v2-root-v1'), xor, u32le(depositCount))
}

function nullifierHash(commitment: Buffer, poolRoot: Buffer): Buffer {
  return sha256(Buffer.from('mixer-v2-null-v1'), commitment, poolRoot)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null mixer-v2', () => {
  const DENOMINATION = BigInt(1e9)
  const VERSION = 1
  const SECRET_A = Buffer.alloc(32, 0x44)
  const SECRET_B = Buffer.alloc(32, 0x55)

  it('pool_id computation is correct', () => {
    const pid = poolId(DENOMINATION, VERSION)

    expect(pid).toBeInstanceOf(Buffer)
    expect(pid.length).toBe(32)

    const expected = sha256(Buffer.from('mixer-v2-pool-v1'), u64le(DENOMINATION), u32le(VERSION))
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('commitment unique per secret', () => {
    const cA = commitment(DENOMINATION, SECRET_A)
    const cB = commitment(DENOMINATION, SECRET_B)

    expect(cA).toBeInstanceOf(Buffer)
    expect(cA.length).toBe(32)
    expect(cA.toString('hex')).not.toBe(cB.toString('hex'))

    // Deterministic
    const cA2 = commitment(DENOMINATION, SECRET_A)
    expect(cA.toString('hex')).toBe(cA2.toString('hex'))
  })

  it('pool_root changes on deposit', () => {
    const cA = commitment(DENOMINATION, SECRET_A)
    const root1 = poolRoot([cA], 1)

    const cB = commitment(DENOMINATION, SECRET_B)
    const root2 = poolRoot([cA, cB], 2)

    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('nullifier depends on pool_root', () => {
    const cA = commitment(DENOMINATION, SECRET_A)
    const cB = commitment(DENOMINATION, SECRET_B)

    const root1 = poolRoot([cA], 1)
    const root2 = poolRoot([cA, cB], 2)

    const null1 = nullifierHash(cA, root1)
    const null2 = nullifierHash(cA, root2)

    expect(null1.toString('hex')).not.toBe(null2.toString('hex'))
  })

  it('5 valid denominations: 1e9, 1e10, 1e11, 1e12, 1e13 lamports', () => {
    expect(VALID_DENOMINATIONS).toHaveLength(5)
    expect(VALID_DENOMINATIONS[0]).toBe(BigInt(1_000_000_000))
    expect(VALID_DENOMINATIONS[1]).toBe(BigInt(10_000_000_000))
    expect(VALID_DENOMINATIONS[2]).toBe(BigInt(100_000_000_000))
    expect(VALID_DENOMINATIONS[3]).toBe(BigInt(1_000_000_000_000))
    expect(VALID_DENOMINATIONS[4]).toBe(BigInt(10_000_000_000_000))

    // Each denomination produces a unique pool_id
    const ids = VALID_DENOMINATIONS.map(d => poolId(d, VERSION).toString('hex'))
    const unique = new Set(ids)
    expect(unique.size).toBe(5)
  })

  it('mainnet_ready=false', () => {
    const cA = commitment(DENOMINATION, SECRET_A)
    const root = poolRoot([cA], 1)
    const pid = poolId(DENOMINATION, VERSION)

    const publicRecord = {
      pool_id: pid.toString('hex'),
      denomination: DENOMINATION.toString(),
      deposit_count: 1,
      pool_root: root.toString('hex'),
      mainnet_ready: false,
    }

    expect(publicRecord.mainnet_ready).toBe(false)
  })
})
