import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Merkle-tree implementation
// Mirrors crates/dark-merkle-proof/src/lib.rs
// ---------------------------------------------------------------------------

/**
 * Leaf hash: SHA256("merkle-leaf-v1" || data)
 */
function merkleLeaf(data: Buffer): Buffer {
  return sha256(Buffer.from('merkle-leaf-v1'), data)
}

/**
 * Internal node hash: SHA256("merkle-node-v1" || sorted(left, right))
 * sorted by lexicographic Buffer comparison so the hash is order-independent
 * for sibling pairs.
 */
function merkleNode(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a]
  return sha256(Buffer.from('merkle-node-v1'), lo, hi)
}

/**
 * Build the Merkle root from an array of leaf data buffers.
 * For an odd count at any level the last node is duplicated.
 */
function buildRoot(dataItems: Buffer[]): Buffer {
  if (dataItems.length === 0) throw new Error('empty tree')

  let level: Buffer[] = dataItems.map(merkleLeaf)

  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i]
      const right = level[i + 1] ?? level[i] // duplicate last for odd count
      next.push(merkleNode(left, right))
    }
    level = next
  }

  return level[0]
}

/**
 * Inclusion proof: array of sibling hashes at each level (bottom-up).
 */
interface MerkleProof {
  root: Buffer
  /** Sibling hash at each level, ordered from leaf level to root level. */
  path: Buffer[]
  leafIndex: number
}

/**
 * Prove inclusion of dataItems[leafIndex] in the tree built from dataItems.
 */
function proveInclusion(dataItems: Buffer[], leafIndex: number): MerkleProof {
  if (dataItems.length === 0) throw new Error('empty tree')

  let level: Buffer[] = dataItems.map(merkleLeaf)
  const path: Buffer[] = []
  let idx = leafIndex

  while (level.length > 1) {
    const sibling =
      idx % 2 === 0
        ? (level[idx + 1] ?? level[idx]) // right sibling (or self if last)
        : level[idx - 1]                  // left sibling

    path.push(sibling)

    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i]
      const right = level[i + 1] ?? level[i]
      next.push(merkleNode(left, right))
    }
    level = next
    idx = Math.floor(idx / 2)
  }

  return { root: level[0], path, leafIndex }
}

/**
 * Verify an inclusion proof.
 */
function verifyInclusion(
  data: Buffer,
  proof: MerkleProof,
): boolean {
  let current = merkleLeaf(data)
  let idx = proof.leafIndex

  for (const sibling of proof.path) {
    current = merkleNode(current, sibling)
    idx = Math.floor(idx / 2)
  }

  return current.equals(proof.root)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null merkle-proof', () => {
  const D = (s: string) => Buffer.from(s, 'utf8')

  it('single leaf: root equals leaf hash', () => {
    const data = D('hello')
    const root = buildRoot([data])
    expect(root.equals(merkleLeaf(data))).toBe(true)
  })

  it('two leaves: root = node_hash(leaf1, leaf2)', () => {
    const d1 = D('alpha')
    const d2 = D('beta')
    const root = buildRoot([d1, d2])
    const expected = merkleNode(merkleLeaf(d1), merkleLeaf(d2))
    expect(root.equals(expected)).toBe(true)
  })

  it('four leaves: tree has correct root', () => {
    const items = [D('a'), D('b'), D('c'), D('d')]
    const [l0, l1, l2, l3] = items.map(merkleLeaf)

    const n01 = merkleNode(l0, l1)
    const n23 = merkleNode(l2, l3)
    const expected = merkleNode(n01, n23)

    expect(buildRoot(items).equals(expected)).toBe(true)
  })

  it('prove and verify inclusion for each of 4 leaves', () => {
    const items = [D('w'), D('x'), D('y'), D('z')]
    for (let i = 0; i < items.length; i++) {
      const proof = proveInclusion(items, i)
      expect(verifyInclusion(items[i], proof)).toBe(true)
    }
  })

  it('root changes on every leaf add', () => {
    const roots: string[] = []
    for (let n = 1; n <= 4; n++) {
      const items = Array.from({ length: n }, (_, i) => D(`item-${i}`))
      roots.push(buildRoot(items).toString('hex'))
    }
    // All roots must be distinct
    const unique = new Set(roots)
    expect(unique.size).toBe(roots.length)
  })

  it('different data produces different leaf hash', () => {
    const h1 = merkleLeaf(D('foo'))
    const h2 = merkleLeaf(D('bar'))
    expect(h1.equals(h2)).toBe(false)
  })
})
