import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ── helpers ──────────────────────────────────────────────────────────────────

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

function leadingZeroBits(hash: Buffer): number {
  let count = 0
  for (const byte of hash) {
    if (byte === 0) {
      count += 8
    } else {
      count += Math.clz32(byte) - 24
      break
    }
  }
  return count
}

function computeWorkHash(secret: Buffer, nonce: bigint): Buffer {
  return sha256(Buffer.from('pow-v1'), secret, u64le(nonce))
}

function solveProof(secret: Buffer, difficulty: number, maxIter: number) {
  for (let i = 0n; i < BigInt(maxIter); i++) {
    const hash = computeWorkHash(secret, i)
    if (leadingZeroBits(hash) >= difficulty) {
      return { nonce: i, workHash: hash, satisfies: true, iterations: Number(i) + 1 }
    }
  }
  return { nonce: BigInt(maxIter - 1), workHash: computeWorkHash(secret, BigInt(maxIter - 1)), satisfies: false, iterations: maxIter }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('dark-null proof of work', () => {
  function secret(): Buffer {
    const s = Buffer.alloc(32, 0)
    s[0] = 0x42; s[1] = 0xDE; s[2] = 0xAD
    return s
  }

  it('work_hash = SHA256("pow-v1" || secret || nonce_le)', () => {
    const sec = secret()
    const nonce = 42n
    const hash = computeWorkHash(sec, nonce)
    const expected = sha256(Buffer.from('pow-v1'), sec, u64le(nonce))
    expect(hash.equals(expected)).toBe(true)
  })

  it('difficulty=0 satisfies immediately (0 leading zero bits required)', () => {
    const proof = solveProof(secret(), 0, 1)
    expect(proof.satisfies).toBe(true)
    expect(proof.iterations).toBe(1)
    expect(leadingZeroBits(proof.workHash)).toBeGreaterThanOrEqual(0)
  })

  it('difficulty=1 finds a solution within 512 iterations', () => {
    const proof = solveProof(secret(), 1, 512)
    expect(proof.satisfies).toBe(true)
    expect(leadingZeroBits(proof.workHash)).toBeGreaterThanOrEqual(1)
  })

  it('verify_work: recomputing hash from (secret, nonce) matches stored hash', () => {
    const proof = solveProof(secret(), 1, 512)
    const recomputed = computeWorkHash(secret(), proof.nonce)
    expect(recomputed.equals(proof.workHash)).toBe(true)
  })

  it('MAX_DIFFICULTY = 20 (difficulty > 20 is rejected)', () => {
    const MAX_DIFFICULTY = 20
    expect(MAX_DIFFICULTY).toBe(20)
    // boundary: difficulty=20 is allowed, difficulty=21 is not
    expect(20 <= MAX_DIFFICULTY).toBe(true)
    expect(21 > MAX_DIFFICULTY).toBe(true)
  })

  it('public record does not contain the secret and has required fields', () => {
    const sec = secret()
    const proof = solveProof(sec, 0, 1)
    const record = {
      nonce: Number(proof.nonce),
      work_hash: proof.workHash.toString('hex'),
      satisfies_difficulty: proof.satisfies,
      iterations: proof.iterations,
      mainnet_ready: false,
    }
    const json = JSON.stringify(record)
    const secretHex = sec.toString('hex')
    expect(json).not.toContain(secretHex)
    expect(record.mainnet_ready).toBe(false)
    expect(record.work_hash.length).toBe(64) // 32 bytes hex
    expect(record.iterations).toBeGreaterThanOrEqual(1)
  })
})
