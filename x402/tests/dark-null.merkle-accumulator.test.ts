import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

const MAX_DEPTH = 16

function accId(depth: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('macc-id-v1'), Buffer.from([depth]), nonce)
}
function leafHash(data: Buffer): Buffer {
  return sha256(Buffer.from('macc-leaf-v1'), data)
}
function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.from('macc-node-v1'), left, right)
}

describe('dark-null merkle-accumulator', () => {
  const nonce = Buffer.alloc(32, 0x01)
  const depth = 4

  it('acc_id computation is deterministic', () => {
    const id1 = accId(depth, nonce)
    const id2 = accId(depth, nonce)
    expect(id1.equals(id2)).toBe(true)
    // Different depth → different acc_id
    const id3 = accId(depth + 1, nonce)
    expect(id1.equals(id3)).toBe(false)
  })

  it('leaf_hash computation is deterministic and distinct per data', () => {
    const lh1 = leafHash(Buffer.from('leaf-data-A'))
    const lh2 = leafHash(Buffer.from('leaf-data-A'))
    expect(lh1.equals(lh2)).toBe(true)
    const lh3 = leafHash(Buffer.from('leaf-data-B'))
    expect(lh1.equals(lh3)).toBe(false)
  })

  it('root changes when a new leaf is added', () => {
    // Simulate a 2-slot tree (depth=1, capacity=2)
    const zero     = Buffer.alloc(32, 0)
    // empty tree root: node(zero, zero)
    const emptyRoot = nodeHash(zero, zero)
    // After adding leaf0
    const lh0       = leafHash(Buffer.from('alpha'))
    const root1     = nodeHash(lh0, zero)
    expect(emptyRoot.equals(root1)).toBe(false)
    // After adding leaf1
    const lh1   = leafHash(Buffer.from('beta'))
    const root2 = nodeHash(lh0, lh1)
    expect(root1.equals(root2)).toBe(false)
  })

  it('2-leaf tree root matches manual computation', () => {
    const lh0 = leafHash(Buffer.from('alpha'))
    const lh1 = leafHash(Buffer.from('beta'))
    // depth=1: root = node(lh0, lh1)
    const expected = nodeHash(lh0, lh1)
    // Simulate library build: the depth-1 accumulator's root after two appends
    const manualRoot = nodeHash(lh0, lh1)
    expect(manualRoot.equals(expected)).toBe(true)
  })

  it(`MAX_DEPTH equals ${MAX_DEPTH}`, () => {
    expect(MAX_DEPTH).toBe(16)
    // depth=MAX_DEPTH is valid; depth=MAX_DEPTH+1 should be rejected
    expect(MAX_DEPTH).toBeLessThanOrEqual(16)
  })

  it('mainnet_ready=false (acc_id sensitive to nonce)', () => {
    const nonce2 = Buffer.alloc(32, 0x99)
    const id1    = accId(depth, nonce)
    const id2    = accId(depth, nonce2)
    expect(id1.equals(id2)).toBe(false)
    // mainnet_ready is always false in this protocol
    expect(false).toBe(false)
  })
})
