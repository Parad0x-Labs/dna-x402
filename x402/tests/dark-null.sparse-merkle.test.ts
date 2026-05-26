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
// Primitives matching Rust sparse-merkle crate
// ---------------------------------------------------------------------------

function treeId(depth: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('smt-id-v1'), Buffer.from([depth]), nonce)
}

function emptyRoot(depth: number): Buffer {
  return sha256(Buffer.from('smt-empty-v1'), Buffer.from([depth]))
}

function keyHash(key: Buffer): Buffer {
  return sha256(Buffer.from('smt-key-v1'), key)
}

function valueHash(val: Buffer): Buffer {
  return sha256(Buffer.from('smt-value-v1'), val)
}

function leafNode(kh: Buffer, vh: Buffer): Buffer {
  return sha256(Buffer.from('smt-leaf-v1'), kh, vh)
}

function xorFold(leaves: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const leaf of leaves) {
    for (let i = 0; i < 32; i++) {
      acc[i] ^= leaf[i]
    }
  }
  return acc
}

function root(leafNodes: Buffer[], count: number): Buffer {
  const folded = xorFold(leafNodes)
  return sha256(Buffer.from('smt-root-v1'), folded, u32le(count))
}

interface SparseMerkleTree {
  tree_id: Buffer
  leaves: Buffer[]
  leaf_count: number
  depth: number
  mainnet_ready: boolean
}

function newTree(depth: number, nonce: Buffer): SparseMerkleTree {
  return {
    tree_id: treeId(depth, nonce),
    leaves: [],
    leaf_count: 0,
    depth,
    mainnet_ready: false,
  }
}

function insertLeaf(tree: SparseMerkleTree, key: Buffer, val: Buffer): SparseMerkleTree {
  const kh = keyHash(key)
  const vh = valueHash(val)
  const leaf = leafNode(kh, vh)
  return {
    ...tree,
    leaves: [...tree.leaves, leaf],
    leaf_count: tree.leaf_count + 1,
  }
}

function computeRoot(tree: SparseMerkleTree): Buffer {
  if (tree.leaves.length === 0) return emptyRoot(tree.depth)
  return root(tree.leaves, tree.leaf_count)
}

function publicRecord(tree: SparseMerkleTree) {
  return {
    tree_id: tree.tree_id.toString('hex'),
    leaf_count: tree.leaf_count,
    mainnet_ready: tree.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DEPTH = 8
const NONCE = Buffer.alloc(32, 0x42)
const KEY1 = Buffer.from('key-one')
const VAL1 = Buffer.from('value-one')
const KEY2 = Buffer.from('key-two')
const VAL2 = Buffer.from('value-two')

describe('dark-null.sparse-merkle', () => {
  it('empty_root = SHA256("smt-empty-v1" || [depth]) for depth=8', () => {
    const expected = sha256(Buffer.from('smt-empty-v1'), Buffer.from([DEPTH]))
    const er = emptyRoot(DEPTH)
    expect(er.toString('hex')).toBe(expected.toString('hex'))
    expect(er.length).toBe(32)
  })

  it('tree_id formula is correct', () => {
    const expected = sha256(Buffer.from('smt-id-v1'), Buffer.from([DEPTH]), NONCE)
    const tid = treeId(DEPTH, NONCE)
    expect(tid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('leaf_node formula is correct', () => {
    const kh = keyHash(KEY1)
    const vh = valueHash(VAL1)
    const expected = sha256(Buffer.from('smt-leaf-v1'), kh, vh)
    const leaf = leafNode(kh, vh)
    expect(leaf.toString('hex')).toBe(expected.toString('hex'))
  })

  it('root changes after inserting a leaf', () => {
    const tree = newTree(DEPTH, NONCE)
    const rootBefore = computeRoot(tree)
    const tree2 = insertLeaf(tree, KEY1, VAL1)
    const rootAfter = computeRoot(tree2)
    expect(rootBefore.toString('hex')).not.toBe(rootAfter.toString('hex'))
  })

  it('two different key/value pairs produce different leaf_nodes', () => {
    const kh1 = keyHash(KEY1)
    const vh1 = valueHash(VAL1)
    const leaf1 = leafNode(kh1, vh1)

    const kh2 = keyHash(KEY2)
    const vh2 = valueHash(VAL2)
    const leaf2 = leafNode(kh2, vh2)

    expect(leaf1.toString('hex')).not.toBe(leaf2.toString('hex'))
  })

  it('public record has tree_id, leaf_count, mainnet_ready=false', () => {
    const tree = newTree(DEPTH, NONCE)
    const t2 = insertLeaf(tree, KEY1, VAL1)
    const rec = publicRecord(t2)
    expect(rec).toHaveProperty('tree_id')
    expect(rec).toHaveProperty('leaf_count')
    expect(rec.leaf_count).toBe(1)
    expect(rec.mainnet_ready).toBe(false)
    expect(rec.tree_id.length).toBe(64)
  })
})
