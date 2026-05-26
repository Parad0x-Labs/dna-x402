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
// NullifierMap (mirrors crates/dark-nullifier-map/src/lib.rs)
//
// EPOCH_WINDOW = 10n
// Errors: AlreadySpent, ZeroNullifier
// ---------------------------------------------------------------------------

const EPOCH_WINDOW = 10n

interface NullifierEntry {
  nullifier: Buffer
  epoch: bigint
}

interface NullifierMap {
  current_epoch: bigint
  entries: NullifierEntry[]
}

function createNullifierMap(current_epoch = 0n): NullifierMap {
  return { current_epoch, entries: [] }
}

function insert(map: NullifierMap, nullifier: Buffer): void {
  if (nullifier.equals(Buffer.alloc(nullifier.length, 0))) {
    throw new Error('ZeroNullifier')
  }
  const exists = map.entries.some(e => e.nullifier.equals(nullifier))
  if (exists) {
    throw new Error('AlreadySpent')
  }
  map.entries.push({ nullifier: Buffer.from(nullifier), epoch: map.current_epoch })
}

function check_nullifier(map: NullifierMap, nullifier: Buffer): boolean {
  const entry = map.entries.find(e => e.nullifier.equals(nullifier))
  if (!entry) return false
  return map.current_epoch - entry.epoch < EPOCH_WINDOW
}

function advance_epoch(map: NullifierMap): void {
  map.current_epoch += 1n
  map.entries = map.entries.filter(e => map.current_epoch - e.epoch < EPOCH_WINDOW)
}

function public_record(map: NullifierMap): object {
  return {
    epoch: map.current_epoch.toString(),
    active_count: map.entries.length,
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null nullifier-map', () => {
  const NULL_A = Buffer.alloc(32).fill(0xaa)
  const NULL_B = Buffer.alloc(32).fill(0xbb)
  const NULL_C = Buffer.alloc(32).fill(0xcc)

  it('insert and check_nullifier: inserted nullifier is present', () => {
    const map = createNullifierMap(0n)
    insert(map, NULL_A)
    expect(check_nullifier(map, NULL_A)).toBe(true)
    // Not-inserted nullifier is absent
    expect(check_nullifier(map, NULL_B)).toBe(false)
  })

  it('double insert detected as AlreadySpent', () => {
    const map = createNullifierMap(0n)
    insert(map, NULL_A)
    expect(() => insert(map, NULL_A)).toThrow('AlreadySpent')
  })

  it('zero nullifier rejected as ZeroNullifier', () => {
    const map = createNullifierMap(0n)
    const zero = Buffer.alloc(32, 0)
    expect(() => insert(map, zero)).toThrow('ZeroNullifier')
  })

  it('advance_epoch prunes entries at exactly EPOCH_WINDOW', () => {
    const map = createNullifierMap(0n)
    insert(map, NULL_A)
    expect(check_nullifier(map, NULL_A)).toBe(true)

    // Advance 9 epochs — nullifier still within window (10 - 9 = 1 ≥ 0, diff < 10)
    for (let i = 0; i < 9; i++) advance_epoch(map)
    expect(check_nullifier(map, NULL_A)).toBe(true)
    expect(map.entries.length).toBe(1)

    // Advance one more — epoch 10, diff = 10 - 0 = 10, NOT < 10 → pruned
    advance_epoch(map)
    expect(map.entries.length).toBe(0)
    expect(check_nullifier(map, NULL_A)).toBe(false)
  })

  it('active_count correct after pruning', () => {
    const map = createNullifierMap(0n)
    insert(map, NULL_A)         // epoch 0
    advance_epoch(map)           // epoch 1
    insert(map, NULL_B)         // epoch 1
    advance_epoch(map)           // epoch 2
    insert(map, NULL_C)         // epoch 2

    expect(map.entries.length).toBe(3)

    // Advance to epoch 10 — NULL_A (epoch 0) pruned, diff = 10 >= 10
    for (let i = 0; i < 8; i++) advance_epoch(map)  // now at epoch 10
    expect(map.current_epoch).toBe(10n)
    // NULL_A: diff = 10 - 0 = 10, NOT < 10 → pruned
    // NULL_B: diff = 10 - 1 = 9, < 10 → kept
    // NULL_C: diff = 10 - 2 = 8, < 10 → kept
    expect(map.entries.length).toBe(2)

    const rec = public_record(map) as Record<string, unknown>
    expect(rec['active_count']).toBe(2)
  })

  it('public record has epoch + active_count, mainnet_ready is false', () => {
    const map = createNullifierMap(5n)
    insert(map, NULL_A)
    insert(map, NULL_B)
    const rec = public_record(map) as Record<string, unknown>

    expect(rec['epoch']).toBe('5')
    expect(rec['active_count']).toBe(2)
    expect(rec['mainnet_ready']).toBe(false)

    // Confirm nullifier bytes do not leak into the public record
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(NULL_A.toString('hex'))
    expect(serialised).not.toContain(NULL_B.toString('hex'))
  })
})
