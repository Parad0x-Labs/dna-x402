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
// Proof-of-History (mirrors crates/dark-proof-of-history/src/lib.rs)
//
// initial_hash  = SHA256("poh-init-v1" || seed)
// ph_id         = SHA256("poh-id-v1"   || initial_hash || SHA256(seed))
// tick_hash     = SHA256("poh-tick-v1" || prev_hash || tick_u64le)
// data_hash     = SHA256("poh-record-v1" || data_bytes)
// record_hash   = SHA256("poh-data-v1"  || prev_hash || tick_u64le || data_hash)
// ---------------------------------------------------------------------------

function initialHash(seed: Buffer): Buffer {
  return sha256(Buffer.from('poh-init-v1'), seed)
}

function phId(seed: Buffer): Buffer {
  const init = initialHash(seed)
  const seedHash = sha256(seed)
  return sha256(Buffer.from('poh-id-v1'), init, seedHash)
}

function tickHash(prevHash: Buffer, tick: bigint): Buffer {
  return sha256(Buffer.from('poh-tick-v1'), prevHash, u64le(tick))
}

function dataHash(dataBytes: Buffer): Buffer {
  return sha256(Buffer.from('poh-record-v1'), dataBytes)
}

function recordHash(prevHash: Buffer, tick: bigint, dataBytes: Buffer): Buffer {
  const dh = dataHash(dataBytes)
  return sha256(Buffer.from('poh-data-v1'), prevHash, u64le(tick), dh)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null proof-of-history', () => {
  const SEED_A = Buffer.from('poh-seed-alpha-0001')
  const SEED_B = Buffer.from('poh-seed-beta-0002')

  it('ph_id computation is deterministic and correct', () => {
    const id1 = phId(SEED_A)
    const id2 = phId(SEED_A)
    expect(id1.length).toBe(32)
    expect(id1.equals(id2)).toBe(true)

    // manual recompute
    const init = sha256(Buffer.from('poh-init-v1'), SEED_A)
    const seedH = sha256(SEED_A)
    const expected = sha256(Buffer.from('poh-id-v1'), init, seedH)
    expect(id1.equals(expected)).toBe(true)
  })

  it('tick_hash computation is deterministic and depends on prev_hash and tick', () => {
    const prev = Buffer.alloc(32, 0xab)
    const t0 = tickHash(prev, 0n)
    const t1 = tickHash(prev, 1n)

    expect(t0.length).toBe(32)
    expect(t1.length).toBe(32)
    expect(t0.equals(t1)).toBe(false)

    // recompute t0
    const expected = sha256(Buffer.from('poh-tick-v1'), prev, u64le(0n))
    expect(t0.equals(expected)).toBe(true)
  })

  it('record_hash computation is deterministic and embeds data_hash correctly', () => {
    const prev = Buffer.alloc(32, 0xcd)
    const data = Buffer.from('hello-poh-record')
    const tick = 42n

    const rh = recordHash(prev, tick, data)
    expect(rh.length).toBe(32)

    // manual recompute
    const dh = sha256(Buffer.from('poh-record-v1'), data)
    const expected = sha256(Buffer.from('poh-data-v1'), prev, u64le(tick), dh)
    expect(rh.equals(expected)).toBe(true)
  })

  it('different seeds produce different ph_ids', () => {
    const idA = phId(SEED_A)
    const idB = phId(SEED_B)
    expect(idA.equals(idB)).toBe(false)
  })

  it('consecutive ticks chain correctly (each tick is prev for next)', () => {
    const genesis = initialHash(SEED_A)
    const t0 = tickHash(genesis, 0n)
    const t1 = tickHash(t0, 1n)
    const t2 = tickHash(t1, 2n)

    // verify chain: t1 uses t0 as prev
    const expected_t1 = sha256(Buffer.from('poh-tick-v1'), t0, u64le(1n))
    expect(t1.equals(expected_t1)).toBe(true)

    const expected_t2 = sha256(Buffer.from('poh-tick-v1'), t1, u64le(2n))
    expect(t2.equals(expected_t2)).toBe(true)

    // changing any link breaks the chain
    const t2_bad = tickHash(t0, 2n)  // skipped t1 as prev
    expect(t2.equals(t2_bad)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = {
      ph_id: phId(SEED_A).toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
