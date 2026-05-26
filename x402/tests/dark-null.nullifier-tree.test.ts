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
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// NullifierTree (mirrors crates/dark-nullifier-tree/src/lib.rs)
//
// tree_id   = SHA256("ntree-id-v1"   || [depth u8] || nonce)
// leaf_hash = SHA256("ntree-leaf-v1" || nullifier || position_u32le)
// root      = SHA256("ntree-root-v1" || XOR_fold(leaf_hashes) || count_u32le)
//
// mainnet_ready = false, MAX_TREE_DEPTH = 20
// ---------------------------------------------------------------------------

const MAX_TREE_DEPTH = 20

interface NullifierTree {
  tree_id: Buffer
  depth: number
  leaves: Buffer[]   // leaf_hashes in insertion order
  mainnet_ready: boolean
}

function computeTreeId(depth: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('ntree-id-v1'), Buffer.from([depth]), nonce)
}

function computeLeafHash(nullifier: Buffer, position: number): Buffer {
  return sha256(Buffer.from('ntree-leaf-v1'), nullifier, u32le(position))
}

function computeRoot(leafHashes: Buffer[], count: number): Buffer {
  const xored = xorFold(leafHashes)
  return sha256(Buffer.from('ntree-root-v1'), xored, u32le(count))
}

function createTree(depth: number, nonce: Buffer): NullifierTree {
  return { tree_id: computeTreeId(depth, nonce), depth, leaves: [], mainnet_ready: false }
}

function insertLeaf(tree: NullifierTree, nullifier: Buffer): void {
  const position = tree.leaves.length
  tree.leaves.push(computeLeafHash(nullifier, position))
}

function getRoot(tree: NullifierTree): Buffer | null {
  if (tree.leaves.length === 0) return null
  return computeRoot(tree.leaves, tree.leaves.length)
}

function contains(tree: NullifierTree, nullifier: Buffer): boolean {
  for (let i = 0; i < tree.leaves.length; i++) {
    const lh = computeLeafHash(nullifier, i)
    if (lh.equals(tree.leaves[i])) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null nullifier-tree', () => {
  const NONCE = Buffer.alloc(32); NONCE[0] = 0xab
  const DEPTH = 20

  it('tree_id computation is correct', () => {
    const tree = createTree(DEPTH, NONCE)
    const expected = sha256(Buffer.from('ntree-id-v1'), Buffer.from([DEPTH]), NONCE)
    expect(tree.tree_id.equals(expected)).toBe(true)
    expect(tree.tree_id.length).toBe(32)
  })

  it('leaf_hash computation is correct', () => {
    const nullifier = Buffer.alloc(32); nullifier[0] = 0x42
    const lh = computeLeafHash(nullifier, 0)
    const expected = sha256(Buffer.from('ntree-leaf-v1'), nullifier, u32le(0))
    expect(lh.equals(expected)).toBe(true)
    expect(lh.length).toBe(32)
  })

  it('root changes on insert', () => {
    const tree = createTree(DEPTH, NONCE)
    const nullA = Buffer.alloc(32); nullA[0] = 0x01
    insertLeaf(tree, nullA)
    const root1 = getRoot(tree)!
    const nullB = Buffer.alloc(32); nullB[0] = 0x02
    insertLeaf(tree, nullB)
    const root2 = getRoot(tree)!
    expect(root1.equals(root2)).toBe(false)
  })

  it('root is deterministic for the same insertions', () => {
    const nullA = Buffer.alloc(32); nullA[0] = 0x10
    const nullB = Buffer.alloc(32); nullB[0] = 0x20
    const tree1 = createTree(DEPTH, NONCE)
    const tree2 = createTree(DEPTH, NONCE)
    insertLeaf(tree1, nullA); insertLeaf(tree1, nullB)
    insertLeaf(tree2, nullA); insertLeaf(tree2, nullB)
    const r1 = getRoot(tree1)!
    const r2 = getRoot(tree2)!
    expect(r1.equals(r2)).toBe(true)
  })

  it('contains check works correctly (simulate)', () => {
    const tree = createTree(DEPTH, NONCE)
    const nullA = Buffer.alloc(32); nullA[0] = 0xcc
    const nullB = Buffer.alloc(32); nullB[0] = 0xdd
    insertLeaf(tree, nullA)
    expect(contains(tree, nullA)).toBe(true)
    expect(contains(tree, nullB)).toBe(false)
  })

  it('mainnet_ready=false and MAX_TREE_DEPTH=20', () => {
    const tree = createTree(DEPTH, NONCE)
    expect(tree.mainnet_ready).toBe(false)
    expect(MAX_TREE_DEPTH).toBe(20)
  })
})
