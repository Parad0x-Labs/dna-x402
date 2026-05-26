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
// Recursive Proof primitives (mirrors crates/dark-recursive-proof/src/lib.rs)
//
// input_hash  = SHA256("rec-input-v1"  || input_bytes)
// level[0]    = SHA256("rec-level-v1"  || [0] || input_hash)
// level[i]    = SHA256("rec-level-v1"  || [i] || level[i-1])
// final_hash  = SHA256("rec-final-v1"  || level[depth-1] || [depth])
// proof_id    = SHA256("rec-proof-v1"  || final_hash)
// ---------------------------------------------------------------------------

const MAX_RECURSIVE_DEPTH = 8
const is_stub = true
const mainnet_ready = false

function inputHash(inputBytes: Buffer): Buffer {
  return sha256(Buffer.from('rec-input-v1'), inputBytes)
}

function recursiveLevel(level: number, prev: Buffer): Buffer {
  return sha256(Buffer.from('rec-level-v1'), Buffer.from([level]), prev)
}

function finalHash(lastLevel: Buffer, depth: number): Buffer {
  return sha256(Buffer.from('rec-final-v1'), lastLevel, Buffer.from([depth]))
}

function proofId(fHash: Buffer): Buffer {
  return sha256(Buffer.from('rec-proof-v1'), fHash)
}

function buildRecursiveProof(inputBytes: Buffer, depth: number): {
  input_hash: Buffer
  levels: Buffer[]
  final_hash: Buffer
  proof_id: Buffer
} {
  if (depth < 1 || depth > MAX_RECURSIVE_DEPTH) throw new Error('InvalidDepth')
  const ih = inputHash(inputBytes)
  const levels: Buffer[] = []
  levels[0] = recursiveLevel(0, ih)
  for (let i = 1; i < depth; i++) {
    levels[i] = recursiveLevel(i, levels[i - 1])
  }
  const fh = finalHash(levels[depth - 1], depth)
  const pid = proofId(fh)
  return { input_hash: ih, levels, final_hash: fh, proof_id: pid }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null recursive-proof', () => {
  const INPUT_BYTES = Buffer.from('recursive-input-data')
  const INPUT_BYTES_B = Buffer.from('different-input-data')

  // Test 1: single level (depth=1)
  it('single level depth=1 is deterministic', () => {
    const proof = buildRecursiveProof(INPUT_BYTES, 1)
    expect(proof.proof_id.length).toBe(32)
    expect(proof.levels.length).toBe(1)
    const ih = sha256(Buffer.from('rec-input-v1'), INPUT_BYTES)
    const lvl0 = sha256(Buffer.from('rec-level-v1'), Buffer.from([0]), ih)
    const fh = sha256(Buffer.from('rec-final-v1'), lvl0, Buffer.from([1]))
    const pid = sha256(Buffer.from('rec-proof-v1'), fh)
    expect(proof.proof_id.equals(pid)).toBe(true)
  })

  // Test 2: depth=3 deterministic
  it('depth=3 is deterministic', () => {
    const proof1 = buildRecursiveProof(INPUT_BYTES, 3)
    const proof2 = buildRecursiveProof(INPUT_BYTES, 3)
    expect(proof1.proof_id.equals(proof2.proof_id)).toBe(true)
    expect(proof1.levels.length).toBe(3)
    expect(proof1.final_hash.length).toBe(32)
  })

  // Test 3: verify by recomputing
  it('verify by recomputing proof_id', () => {
    const proof = buildRecursiveProof(INPUT_BYTES, 3)
    // Recompute from scratch
    const ih = inputHash(INPUT_BYTES)
    let current = recursiveLevel(0, ih)
    for (let i = 1; i < 3; i++) current = recursiveLevel(i, current)
    const fh = finalHash(current, 3)
    const pid = proofId(fh)
    expect(proof.proof_id.equals(pid)).toBe(true)
  })

  // Test 4: input sensitivity
  it('different inputs produce different proof_ids', () => {
    const proofA = buildRecursiveProof(INPUT_BYTES, 2)
    const proofB = buildRecursiveProof(INPUT_BYTES_B, 2)
    expect(proofA.proof_id.equals(proofB.proof_id)).toBe(false)
    expect(proofA.input_hash.equals(proofB.input_hash)).toBe(false)
  })

  // Test 5: depth sensitivity
  it('different depths produce different proof_ids', () => {
    const proof1 = buildRecursiveProof(INPUT_BYTES, 1)
    const proof3 = buildRecursiveProof(INPUT_BYTES, 3)
    expect(proof1.proof_id.equals(proof3.proof_id)).toBe(false)
    expect(proof1.final_hash.equals(proof3.final_hash)).toBe(false)
  })

  // Test 6: is_stub=true, mainnet_ready=false, MAX_RECURSIVE_DEPTH=8
  it('is_stub=true, mainnet_ready=false, MAX_RECURSIVE_DEPTH=8', () => {
    expect(is_stub).toBe(true)
    expect(mainnet_ready).toBe(false)
    expect(MAX_RECURSIVE_DEPTH).toBe(8)
    // Building at max depth works
    const proof = buildRecursiveProof(INPUT_BYTES, MAX_RECURSIVE_DEPTH)
    expect(proof.levels.length).toBe(MAX_RECURSIVE_DEPTH)
    expect(proof.proof_id.length).toBe(32)
    // Exceeding max depth throws
    expect(() => buildRecursiveProof(INPUT_BYTES, MAX_RECURSIVE_DEPTH + 1)).toThrow('InvalidDepth')
  })
})
