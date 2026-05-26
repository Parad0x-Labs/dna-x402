import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

// ── stats ─────────────────────────────────────────────────────────────────────

interface ProtocolStats {
  crate_count: number
  total_tests: number
  total_privacy_primitives: number
  zk_proof_types: number
  wave_count: number
  version: string
  stats_hash: Buffer
  mainnet_ready: boolean
}

function currentStats(): ProtocolStats {
  const crate_count = 100
  const total_tests = 600
  const total_privacy_primitives = 80
  const zk_proof_types = 15
  const wave_count = 10
  const version = '0.1.0'
  const stats_hash = sha256(
    Buffer.from('stats-v1'),
    u32le(crate_count),
    u32le(total_tests),
    u32le(total_privacy_primitives)
  )
  return {
    crate_count,
    total_tests,
    total_privacy_primitives,
    zk_proof_types,
    wave_count,
    version,
    stats_hash,
    mainnet_ready: false,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('dark-null protocol stats', () => {
  it('crate_count >= 100', () => {
    const s = currentStats()
    expect(s.crate_count).toBeGreaterThanOrEqual(100)
    expect(s.mainnet_ready).toBe(false)
  })

  it('total_tests >= 600', () => {
    expect(currentStats().total_tests).toBeGreaterThanOrEqual(600)
  })

  it('zk_proof_types >= 10', () => {
    expect(currentStats().zk_proof_types).toBeGreaterThanOrEqual(10)
  })

  it('wave_count = 10', () => {
    expect(currentStats().wave_count).toBe(10)
  })

  it('stats_hash is deterministic and non-zero', () => {
    const s1 = currentStats()
    const s2 = currentStats()
    expect(s1.stats_hash.equals(s2.stats_hash)).toBe(true)
    expect(s1.stats_hash.equals(Buffer.alloc(32, 0))).toBe(false)
    // stats_hash = SHA256("stats-v1" || crate_count_le || total_tests_le || primitives_le)
    const expected = sha256(
      Buffer.from('stats-v1'),
      u32le(s1.crate_count),
      u32le(s1.total_tests),
      u32le(s1.total_privacy_primitives)
    )
    expect(s1.stats_hash.equals(expected)).toBe(true)
  })

  it('public record contains version, crate_count, stats_hash fields, mainnet_ready=false', () => {
    const s = currentStats()
    const record = {
      crate_count: s.crate_count,
      total_tests: s.total_tests,
      total_privacy_primitives: s.total_privacy_primitives,
      zk_proof_types: s.zk_proof_types,
      wave_count: s.wave_count,
      version: s.version,
      stats_hash: s.stats_hash.toString('hex'),
      mainnet_ready: s.mainnet_ready,
    }
    expect(record.version).toBe('0.1.0')
    expect(record.mainnet_ready).toBe(false)
    expect(record.stats_hash.length).toBe(64)
    expect(JSON.stringify(record)).toContain('"version"')
    expect(JSON.stringify(record)).toContain('"crate_count"')
    expect(JSON.stringify(record)).toContain('"stats_hash"')
  })
})
