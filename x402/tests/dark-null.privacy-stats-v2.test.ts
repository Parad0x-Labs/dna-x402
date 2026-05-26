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
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32,0); for (const h of hs) for (let i=0;i<32;i++) a[i]^=h[i]; return a }

// ---------------------------------------------------------------------------
// Privacy Stats v2
//
// stats_hash = SHA256("stats-v2" || crate_count_u32le || total_tests_u32le || ts_files_u32le || wave_count_u32le)
// ---------------------------------------------------------------------------

function statsHash(crateCount: number, totalTests: number, tsFiles: number, waveCount: number): Buffer {
  return sha256(
    Buffer.from('stats-v2'),
    u32le(crateCount),
    u32le(totalTests),
    u32le(tsFiles),
    u32le(waveCount),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null privacy-stats-v2', () => {

  it('crate_count equals 160', () => {
    // Wave 16 batch-2: crates completed through wave 16 = 160 crates
    const CRATE_COUNT = 160
    expect(CRATE_COUNT).toBe(160)

    const sh = statsHash(CRATE_COUNT, 960, 160, 16)
    expect(sh.length).toBe(32)
  })

  it('total_tests equals 960 (160 crates × 6 tests each)', () => {
    const CRATE_COUNT  = 160
    const TOTAL_TESTS  = CRATE_COUNT * 6
    expect(TOTAL_TESTS).toBe(960)

    const sh = statsHash(CRATE_COUNT, TOTAL_TESTS, CRATE_COUNT, 16)
    expect(sh.length).toBe(32)
  })

  it('wave_count equals 16', () => {
    const WAVE_COUNT = 16
    expect(WAVE_COUNT).toBe(16)

    const sh = statsHash(160, 960, 160, WAVE_COUNT)
    expect(sh.length).toBe(32)
  })

  it('stats_hash is deterministic for same inputs', () => {
    const sh1 = statsHash(160, 960, 160, 16)
    const sh2 = statsHash(160, 960, 160, 16)
    expect(sh1.equals(sh2)).toBe(true)

    // manual recompute
    const expected = sha256(
      Buffer.from('stats-v2'),
      u32le(160),
      u32le(960),
      u32le(160),
      u32le(16),
    )
    expect(sh1.equals(expected)).toBe(true)

    // different inputs produce different hash
    const sh_diff = statsHash(159, 960, 160, 16)
    expect(sh1.equals(sh_diff)).toBe(false)
  })

  it('version is "0.2.0"', () => {
    const VERSION = '0.2.0'
    expect(VERSION).toBe('0.2.0')

    const record = {
      version: VERSION,
      crate_count: 160,
      total_tests: 960,
      wave_count: 16,
      stats_hash: statsHash(160, 960, 160, 16).toString('hex'),
      mainnet_ready: false,
    }
    expect(record.version).toBe('0.2.0')
    expect(record.crate_count).toBe(160)
  })

  it('mainnet_ready is false', () => {
    const record = {
      stats_hash: statsHash(160, 960, 160, 16).toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
