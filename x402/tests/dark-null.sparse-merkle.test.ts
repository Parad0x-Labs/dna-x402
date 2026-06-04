import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Canonical TypeScript mirror of crates/dark-sparse-merkle/src/lib.rs.
//
// This MUST match the Rust crate exactly so a proof produced by one side
// verifies on the other. Reproduced verbatim: the domain tags, the leaf-index
// bit layout (top `depth` bits of the first 16 bytes of the key hash, taken
// big-endian), the precomputed empty-subtree chain, and the leaf->root sibling
// walk. Because the interior `smt-node-v1` nodes exist, this mirror can produce
// real sibling co-paths and therefore verify BOTH inclusion AND non-membership.
//
//   empty(0)    = SHA256("smt-empty-v1" || 0x00)
//   empty(d)    = SHA256("smt-node-v1"  || empty(d-1) || empty(d-1))
//   key(k)      = SHA256("smt-key-v1"   || k)
//   value(v)    = SHA256("smt-value-v1" || v)
//   leaf(kh,vh) = SHA256("smt-leaf-v1"  || kh || vh)
//   node(l,r)   = SHA256("smt-node-v1"  || l || r)
//
// HISTORY: the previous version of this file folded a NON-CANONICAL root,
//   SHA256("smt-root-v1" || xorFold(leaves) || count) — an order-independent
//   XOR with no interior nodes. It had no sibling co-paths, so it could not
//   verify inclusion-by-path OR non-membership, and it diverged from the Rust
//   crate. It also invented a tree_id / "smt-id-v1" / nonce that the crate does
//   not have. Both are removed; the test below pins the canonical construction
//   and asserts the canonical root is NOT the old xor-fold (see last test).
// ---------------------------------------------------------------------------

const DOMAIN_EMPTY = Buffer.from('smt-empty-v1')
const DOMAIN_LEAF = Buffer.from('smt-leaf-v1')
const DOMAIN_NODE = Buffer.from('smt-node-v1')
const DOMAIN_KEY = Buffer.from('smt-key-v1')
const DOMAIN_VALUE = Buffer.from('smt-value-v1')

const MAX_DEPTH = 32

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function hashKey(key: Buffer): Buffer {
  return sha256(DOMAIN_KEY, key)
}
function hashValue(value: Buffer): Buffer {
  return sha256(DOMAIN_VALUE, value)
}
function leafHash(kh: Buffer, vh: Buffer): Buffer {
  return sha256(DOMAIN_LEAF, kh, vh)
}
function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(DOMAIN_NODE, left, right)
}

// Precompute empty-subtree hashes for levels 0..=depth (inclusive).
// empties[0] is the empty leaf; empties[depth] is the empty root.
function emptyHashes(depth: number): Buffer[] {
  const empties: Buffer[] = [sha256(DOMAIN_EMPTY, Buffer.from([0]))]
  for (let i = 1; i <= depth; i++) {
    const prev = empties[i - 1]
    empties.push(nodeHash(prev, prev))
  }
  return empties
}

// Leaf index = top `depth` bits of the first 16 bytes (big-endian u128) of kh.
// Mirrors: path_full = u128::from_be_bytes(kh[0..16]); leaf_idx = path_full >> (128 - depth)
function leafIndex(kh: Buffer, depth: number): bigint {
  let pathFull = 0n
  for (let i = 0; i < 16; i++) pathFull = (pathFull << 8n) | BigInt(kh[i])
  return pathFull >> BigInt(128 - depth)
}

interface SparseProof {
  keyHash: Buffer
  // Some(leaf hash) for an inclusion proof; null for a non-membership proof.
  valueHash: Buffer | null
  // One sibling per level, leaf -> root. length === depth.
  siblings: Buffer[]
  root: Buffer
}

class SparseMerkleTree {
  readonly depth: number
  root: Buffer
  leafCount = 0
  readonly mainnet_ready = false
  private readonly empty: Buffer[]
  private readonly nodes = new Map<string, Buffer>()

  constructor(depth: number) {
    if (depth === 0) throw new Error('DepthZero')
    if (depth > MAX_DEPTH) throw new Error('DepthTooHigh')
    this.depth = depth
    this.empty = emptyHashes(depth)
    this.root = this.empty[depth]
  }

  private nodeKey(level: number, path: bigint): string {
    return `${level}:${path.toString(16)}`
  }

  private getNode(level: number, path: bigint): Buffer {
    return this.nodes.get(this.nodeKey(level, path)) ?? this.empty[level]
  }

  private getLeaf(kh: Buffer): Buffer | null {
    const stored = this.nodes.get(this.nodeKey(0, leafIndex(kh, this.depth)))
    if (!stored || stored.equals(this.empty[0])) return null
    return stored
  }

  contains(key: Buffer): boolean {
    return this.getLeaf(hashKey(key)) !== null
  }

  insert(key: Buffer, value: Buffer): Buffer {
    if (key.length === 0) throw new Error('EmptyKey')
    if (value.length === 0) throw new Error('EmptyValue')
    const kh = hashKey(key)
    const lh = leafHash(kh, hashValue(value))
    const wasEmpty = this.getLeaf(kh) === null

    const idx = leafIndex(kh, this.depth)
    this.nodes.set(this.nodeKey(0, idx), lh)

    // Recompute from the leaf up to the root.
    let current = lh
    let path = idx
    for (let level = 0; level < this.depth; level++) {
      const sibling = this.getNode(level, path ^ 1n)
      const [left, right] = (path & 1n) === 0n ? [current, sibling] : [sibling, current]
      current = nodeHash(left, right)
      path >>= 1n
      this.nodes.set(this.nodeKey(level + 1, path), current)
    }
    this.root = current
    if (wasEmpty) this.leafCount += 1
    return lh
  }

  // Inclusion proof if the key is present, non-membership proof if absent.
  prove(key: Buffer): SparseProof {
    const kh = hashKey(key)
    const idx = leafIndex(kh, this.depth)
    const stored = this.nodes.get(this.nodeKey(0, idx))
    const valueHash = stored && !stored.equals(this.empty[0]) ? stored : null

    const siblings: Buffer[] = []
    let path = idx
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.getNode(level, path ^ 1n))
      path >>= 1n
    }
    return { keyHash: kh, valueHash, siblings, root: this.root }
  }
}

// Standalone verifier — needs only the proof + depth, never the tree.
// Mirrors verify_proof() in the Rust crate: inclusion starts from the stored
// leaf hash, non-membership starts from the empty leaf, then walks the co-path.
function verifyProof(proof: SparseProof, depth: number): boolean {
  if (proof.siblings.length !== depth) return false
  const baseEmpty = sha256(DOMAIN_EMPTY, Buffer.from([0]))
  let current = proof.valueHash ?? baseEmpty
  let path = leafIndex(proof.keyHash, depth)
  for (const sibling of proof.siblings) {
    const [left, right] = (path & 1n) === 0n ? [current, sibling] : [sibling, current]
    current = nodeHash(left, right)
    path >>= 1n
  }
  return current.equals(proof.root)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DEPTH = 16
const KEY1 = Buffer.from('nullifier-001')
const VAL1 = Buffer.from('spent')

describe('dark-null.sparse-merkle (canonical Rust mirror)', () => {
  it('empty root is deterministic, non-zero, and mainnet_ready=false', () => {
    const a = new SparseMerkleTree(8)
    const b = new SparseMerkleTree(8)
    expect(a.root.equals(b.root)).toBe(true)
    expect(a.root.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(a.mainnet_ready).toBe(false)
  })

  it('hash formulas match the crate domain tags', () => {
    const kh = hashKey(Buffer.from('key-one'))
    const vh = hashValue(Buffer.from('value-one'))
    expect(leafHash(kh, vh).equals(sha256(DOMAIN_LEAF, kh, vh))).toBe(true)
    expect(emptyHashes(8)[0].equals(sha256(DOMAIN_EMPTY, Buffer.from([0])))).toBe(true)

    // The empty root at depth D folds the chain with node-domain hashing.
    let folded = sha256(DOMAIN_EMPTY, Buffer.from([0]))
    for (let i = 0; i < 8; i++) folded = nodeHash(folded, folded)
    expect(new SparseMerkleTree(8).root.equals(folded)).toBe(true)
  })

  it('leaf and node hashing are domain-separated', () => {
    const a = Buffer.alloc(32, 1)
    const b = Buffer.alloc(32, 2)
    expect(leafHash(a, b).equals(nodeHash(a, b))).toBe(false)
  })

  it('depth 0 and depth > MAX_DEPTH are rejected', () => {
    expect(() => new SparseMerkleTree(0)).toThrow('DepthZero')
    expect(() => new SparseMerkleTree(MAX_DEPTH + 1)).toThrow('DepthTooHigh')
  })

  it('root changes after inserting a leaf', () => {
    const tree = new SparseMerkleTree(DEPTH)
    const before = tree.root
    tree.insert(KEY1, VAL1)
    expect(tree.root.equals(before)).toBe(false)
  })

  it('inclusion proof verifies via a real co-path', () => {
    const tree = new SparseMerkleTree(DEPTH)
    tree.insert(KEY1, VAL1)
    const proof = tree.prove(KEY1)
    expect(proof.valueHash).not.toBeNull()
    expect(proof.siblings.length).toBe(DEPTH)
    expect(verifyProof(proof, DEPTH)).toBe(true)
  })

  it('non-membership proof verifies via a real co-path', () => {
    const tree = new SparseMerkleTree(DEPTH)
    tree.insert(KEY1, VAL1)
    // Prove nullifier-002 is NOT in the tree.
    const proof = tree.prove(Buffer.from('nullifier-002'))
    expect(proof.valueHash).toBeNull()
    expect(proof.siblings.length).toBe(DEPTH)
    expect(verifyProof(proof, DEPTH)).toBe(true)
  })

  it('non-membership proof in an empty tree verifies', () => {
    const tree = new SparseMerkleTree(8)
    const proof = tree.prove(Buffer.from('any-key'))
    expect(proof.valueHash).toBeNull()
    expect(verifyProof(proof, 8)).toBe(true)
  })

  it('tampering with a sibling makes the proof fail (soundness)', () => {
    const tree = new SparseMerkleTree(DEPTH)
    tree.insert(Buffer.from('a'), Buffer.from('1'))
    tree.insert(Buffer.from('b'), Buffer.from('2'))
    const proof = tree.prove(Buffer.from('a'))
    expect(verifyProof(proof, DEPTH)).toBe(true)

    const tampered: SparseProof = {
      ...proof,
      siblings: proof.siblings.map((s, i) => (i === 0 ? Buffer.from(s).fill(0xff) : s)),
    }
    expect(verifyProof(tampered, DEPTH)).toBe(false)
  })

  it('a proof does not verify against a stale root', () => {
    const tree = new SparseMerkleTree(8)
    tree.insert(Buffer.from('k1'), Buffer.from('v1'))
    const proof = tree.prove(Buffer.from('k1'))
    expect(verifyProof(proof, 8)).toBe(true)

    // Mutate the tree; the OLD co-path now reconstructs a stale root.
    tree.insert(Buffer.from('k2'), Buffer.from('v2'))
    const stale: SparseProof = { ...proof, root: tree.root }
    expect(verifyProof(stale, 8)).toBe(false)
  })

  it('different keys produce different leaf hashes and both proofs verify', () => {
    const tree = new SparseMerkleTree(8)
    tree.insert(Buffer.from('key-alpha'), Buffer.from('val'))
    tree.insert(Buffer.from('key-beta'), Buffer.from('val'))
    const p1 = tree.prove(Buffer.from('key-alpha'))
    const p2 = tree.prove(Buffer.from('key-beta'))
    expect(p1.keyHash.equals(p2.keyHash)).toBe(false)
    expect(verifyProof(p1, 8)).toBe(true)
    expect(verifyProof(p2, 8)).toBe(true)
  })

  it('inserting the same key/value twice is idempotent', () => {
    const tree = new SparseMerkleTree(8)
    tree.insert(Buffer.from('key'), Buffer.from('value'))
    const after1 = tree.root
    tree.insert(Buffer.from('key'), Buffer.from('value'))
    expect(tree.root.equals(after1)).toBe(true)
  })

  it('updating a key to a new value changes the root', () => {
    const tree = new SparseMerkleTree(8)
    tree.insert(Buffer.from('key'), Buffer.from('v1'))
    const r1 = tree.root
    tree.insert(Buffer.from('key'), Buffer.from('v2'))
    expect(tree.root.equals(r1)).toBe(false)
  })

  it('contains() reflects insertions', () => {
    const tree = new SparseMerkleTree(8)
    expect(tree.contains(Buffer.from('nullifier-x'))).toBe(false)
    tree.insert(Buffer.from('nullifier-x'), Buffer.from('1'))
    expect(tree.contains(Buffer.from('nullifier-x'))).toBe(true)
    expect(tree.contains(Buffer.from('nullifier-y'))).toBe(false)
  })

  it('many insertions: every inclusion proof verifies', () => {
    const tree = new SparseMerkleTree(DEPTH)
    const keys = Array.from({ length: 20 }, (_, i) => Buffer.from(`nullifier-${i}`))
    for (const k of keys) tree.insert(k, Buffer.from('spent'))
    for (const k of keys) {
      const proof = tree.prove(k)
      expect(proof.valueHash).not.toBeNull()
      expect(verifyProof(proof, DEPTH)).toBe(true)
    }
    expect(tree.leafCount).toBe(20)
  })

  it('insertion order does not change the final root', () => {
    const t1 = new SparseMerkleTree(8)
    t1.insert(Buffer.from('a'), Buffer.from('1'))
    t1.insert(Buffer.from('b'), Buffer.from('2'))
    t1.insert(Buffer.from('c'), Buffer.from('3'))

    const t2 = new SparseMerkleTree(8)
    t2.insert(Buffer.from('c'), Buffer.from('3'))
    t2.insert(Buffer.from('a'), Buffer.from('1'))
    t2.insert(Buffer.from('b'), Buffer.from('2'))

    expect(t1.root.equals(t2.root)).toBe(true)
  })

  it('trees of different depths have different empty roots', () => {
    expect(new SparseMerkleTree(8).root.equals(new SparseMerkleTree(16).root)).toBe(false)
  })

  it('the canonical root is NOT the old non-canonical xor-fold', () => {
    const tree = new SparseMerkleTree(8)
    const leaves: Buffer[] = []
    for (const [k, v] of [['a', '1'], ['b', '2'], ['c', '3']] as const) {
      leaves.push(tree.insert(Buffer.from(k), Buffer.from(v)))
    }
    // Old broken construction: SHA256("smt-root-v1" || xorFold(leaves) || u32le(count)).
    const acc = Buffer.alloc(32, 0)
    for (const leaf of leaves) for (let i = 0; i < 32; i++) acc[i] ^= leaf[i]
    const count = Buffer.alloc(4)
    count.writeUInt32LE(leaves.length)
    const xorFoldRoot = sha256(Buffer.from('smt-root-v1'), acc, count)
    expect(tree.root.equals(xorFoldRoot)).toBe(false)
  })
})
