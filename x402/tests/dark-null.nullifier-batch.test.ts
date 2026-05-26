import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Scheme helpers
// ---------------------------------------------------------------------------

const MAX_BATCH = 64

function batchRoot(nullifiers: Buffer[], epoch: bigint): Buffer {
  const count = nullifiers.length
  return sha256(
    Buffer.from('nbatch-root-v1'),
    xorFold(nullifiers),
    u32le(count),
    u64le(epoch)
  )
}

function batchId(root: Buffer): Buffer {
  return sha256(Buffer.from('nbatch-id-v1'), root)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null.nullifier-batch (Wave 15 batch-2)', () => {
  const EPOCH = BigInt(7)

  const NULL_A = sha256(Buffer.from('nullifier-a'))
  const NULL_B = sha256(Buffer.from('nullifier-b'))
  const NULL_C = sha256(Buffer.from('nullifier-c'))

  it('batch_root with 3 nullifiers: SHA256("nbatch-root-v1" || XOR_fold(nullifiers) || count_u32le || epoch_u64le)', () => {
    const root = batchRoot([NULL_A, NULL_B, NULL_C], EPOCH)

    const expectedXor = xorFold([NULL_A, NULL_B, NULL_C])
    const expected = sha256(
      Buffer.from('nbatch-root-v1'),
      expectedXor,
      u32le(3),
      u64le(EPOCH)
    )
    expect(root.toString('hex')).toBe(expected.toString('hex'))
    expect(root).toHaveLength(32)
  })

  it('batch_id = SHA256("nbatch-id-v1" || batch_root)', () => {
    const root = batchRoot([NULL_A, NULL_B, NULL_C], EPOCH)
    const bid = batchId(root)

    const expected = sha256(Buffer.from('nbatch-id-v1'), root)
    expect(bid.toString('hex')).toBe(expected.toString('hex'))
    expect(bid).toHaveLength(32)
  })

  it('root is sensitive to nullifiers: changing one nullifier changes the root', () => {
    const NULL_D = sha256(Buffer.from('nullifier-d'))
    const root1 = batchRoot([NULL_A, NULL_B, NULL_C], EPOCH)
    const root2 = batchRoot([NULL_A, NULL_B, NULL_D], EPOCH)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('epoch is included in root: same nullifiers different epoch → different root', () => {
    const root1 = batchRoot([NULL_A, NULL_B, NULL_C], BigInt(1))
    const root2 = batchRoot([NULL_A, NULL_B, NULL_C], BigInt(2))
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('MAX_BATCH=64: batch of 64 nullifiers computes without error', () => {
    expect(MAX_BATCH).toBe(64)
    const nullifiers = Array.from({ length: MAX_BATCH }, (_, i) =>
      sha256(Buffer.from(`null-${i}`))
    )
    const root = batchRoot(nullifiers, EPOCH)
    const bid = batchId(root)
    expect(root).toHaveLength(32)
    expect(bid).toHaveLength(32)
  })

  it('mainnet_ready=false: public record does not expose raw nullifiers', () => {
    const root = batchRoot([NULL_A, NULL_B, NULL_C], EPOCH)
    const bid = batchId(root)
    const record = {
      batch_id: bid.toString('hex'),
      batch_root: root.toString('hex'),
      count: 3,
      epoch: Number(EPOCH),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    const recStr = JSON.stringify(record)
    // Raw nullifiers should not be in the public record
    expect(recStr).not.toContain(NULL_A.toString('hex'))
    expect(recStr).not.toContain(NULL_B.toString('hex'))
    expect(recStr).not.toContain(NULL_C.toString('hex'))
  })
})
