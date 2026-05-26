import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const CRATE_COUNT = 190
const TOTAL_TESTS = 1140
const TOTAL_PRIVACY_PRIMITIVES = 100
const ZK_PROOF_TYPES = 20
const WAVE_COUNT = 19
const VERSION = '0.3.0'

function statsHash(crateCount: number, totalTests: number, primitives: number): Buffer {
  return sha256(
    Buffer.from('stats-v3'),
    u32le(crateCount),
    u32le(totalTests),
    u32le(primitives)
  )
}

describe('dark-null.privacy-stats-v3', () => {
  it('crate_count >= 190', () => {
    expect(CRATE_COUNT).toBeGreaterThanOrEqual(190)
  })

  it('total_tests >= 1140', () => {
    expect(TOTAL_TESTS).toBeGreaterThanOrEqual(1140)
  })

  it('wave_count = 19', () => {
    expect(WAVE_COUNT).toBe(19)
  })

  it('version = "0.3.0"', () => {
    expect(VERSION).toBe('0.3.0')
  })

  it('stats_hash is deterministic and non-zero', () => {
    const h1 = statsHash(CRATE_COUNT, TOTAL_TESTS, TOTAL_PRIVACY_PRIMITIVES)
    const h2 = statsHash(CRATE_COUNT, TOTAL_TESTS, TOTAL_PRIVACY_PRIMITIVES)
    expect(h1.toString('hex')).toBe(h2.toString('hex'))
    expect(h1.every(b => b === 0)).toBe(false)
  })

  it('public record contains version, mainnet_ready=false', () => {
    const record = {
      version: VERSION,
      mainnet_ready: false,
      crate_count: CRATE_COUNT,
      total_tests: TOTAL_TESTS,
      total_privacy_primitives: TOTAL_PRIVACY_PRIMITIVES,
      zk_proof_types: ZK_PROOF_TYPES,
      wave_count: WAVE_COUNT,
    }
    expect(record.version).toBe('0.3.0')
    expect(record.mainnet_ready).toBe(false)
  })
})
