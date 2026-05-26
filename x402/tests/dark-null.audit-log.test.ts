import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

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

// ---------------------------------------------------------------------------
// Primitives matching crates/dark-audit-log/src/lib.rs
// ---------------------------------------------------------------------------

function event_hash(event_bytes: Buffer): Buffer {
  return sha256(Buffer.from('audit-entry-v1'), event_bytes)
}

function entry_hash(
  prev_entry_hash: Buffer,
  ev_hash: Buffer,
  index: number,
): Buffer {
  return sha256(
    Buffer.from('audit-chain-v1'),
    prev_entry_hash,
    ev_hash,
    u32le(index),
  )
}

interface AuditEntry {
  index: number
  event_bytes: Buffer
  event_hash: Buffer
  entry_hash: Buffer
}

interface AuditLog {
  entries: AuditEntry[]
  head: Buffer
}

function append(log: AuditLog, event_bytes: Buffer): AuditLog {
  const ev_hash = event_hash(event_bytes)
  const prev = log.head
  const index = log.entries.length
  const eh = entry_hash(prev, ev_hash, index)
  const entry: AuditEntry = { index, event_bytes, event_hash: ev_hash, entry_hash: eh }
  return { entries: [...log.entries, entry], head: eh }
}

function create_log(): AuditLog {
  return { entries: [], head: Buffer.alloc(32, 0) }
}

function verify_log(log: AuditLog): boolean {
  let prev = Buffer.alloc(32, 0)
  for (const entry of log.entries) {
    const ev_hash = event_hash(entry.event_bytes)
    const expected = entry_hash(prev, ev_hash, entry.index)
    if (!expected.equals(entry.entry_hash)) return false
    prev = entry.entry_hash
  }
  return true
}

function public_record(log: AuditLog): { head_hex: string; entry_count: number } {
  return { head_hex: log.head.toString('hex'), entry_count: log.entries.length }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-audit-log', () => {
  it('append 5 entries, verify_log passes (recompute chain)', () => {
    let log = create_log()
    for (let i = 0; i < 5; i++) {
      log = append(log, Buffer.from(`event-${i}`))
    }
    expect(log.entries).toHaveLength(5)
    expect(verify_log(log)).toBe(true)
  })

  it('empty event: detect in TS (0-length bytes)', () => {
    const ev = Buffer.alloc(0)
    expect(ev.length).toBe(0)
    // An empty event_bytes produces a deterministic hash (not undefined),
    // but callers should guard against empty payloads.
    const eh = event_hash(ev)
    expect(eh).toHaveLength(32)
    // Confirm it differs from any non-empty event
    const non_empty = event_hash(Buffer.from('x'))
    expect(eh.equals(non_empty)).toBe(false)
  })

  it('head advances on each append', () => {
    let log = create_log()
    const heads: string[] = [log.head.toString('hex')]
    for (let i = 0; i < 3; i++) {
      log = append(log, Buffer.from(`e${i}`))
      heads.push(log.head.toString('hex'))
    }
    // All four values (genesis + 3 appends) must be distinct
    const unique = new Set(heads)
    expect(unique.size).toBe(4)
  })

  it('tamper: modify one entry_hash, verify detects ChainBroken', () => {
    let log = create_log()
    for (let i = 0; i < 4; i++) {
      log = append(log, Buffer.from(`event-${i}`))
    }
    expect(verify_log(log)).toBe(true)

    // Tamper with entry at index 1
    const tampered_entries = log.entries.map((e, i) => {
      if (i === 1) {
        const bad_hash = Buffer.alloc(32, 0xab)
        return { ...e, entry_hash: bad_hash }
      }
      return e
    })
    const tampered_log: AuditLog = { entries: tampered_entries, head: log.head }
    expect(verify_log(tampered_log)).toBe(false)
  })

  it('entry_hash is sensitive to index — same event, different index → different hash', () => {
    const ev = Buffer.from('same-event')
    const ev_hash = event_hash(ev)
    const prev = Buffer.alloc(32, 0)
    const h0 = entry_hash(prev, ev_hash, 0)
    const h1 = entry_hash(prev, ev_hash, 1)
    expect(h0.equals(h1)).toBe(false)
  })

  it('public record: head hex + entry_count; no raw events', () => {
    let log = create_log()
    log = append(log, Buffer.from('secret-event'))
    log = append(log, Buffer.from('another-secret'))

    const rec = public_record(log)
    expect(typeof rec.head_hex).toBe('string')
    expect(rec.head_hex).toHaveLength(64) // 32 bytes as hex
    expect(rec.entry_count).toBe(2)

    // The public record must not expose raw event bytes
    const recStr = JSON.stringify(rec)
    expect(recStr).not.toContain('secret-event')
    expect(recStr).not.toContain('another-secret')
    expect(recStr).not.toContain('event_bytes')
  })
})
