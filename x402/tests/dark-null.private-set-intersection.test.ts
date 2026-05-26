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

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  return Buffer.from(a.map((byte, i) => byte ^ b[i]))
}

// ---------------------------------------------------------------------------
// Private Set Intersection
// Mirrors crates/dark-private-set-intersection/src/lib.rs
// ---------------------------------------------------------------------------

const PSI_ELEM_TAG  = Buffer.from('psi-elem-v1')
const PSI_SET_TAG   = Buffer.from('psi-set-v1')
const PSI_PROOF_TAG = Buffer.from('psi-proof-v1')

function psiElementHash(elementBytes: Buffer, partySecret: Buffer): Buffer {
  return sha256(PSI_ELEM_TAG, elementBytes, partySecret)
}

function psiSetHash(elements: Buffer[], partySecret: Buffer): { setHash: Buffer; elementHashes: Buffer[] } {
  const elementHashes = elements.map(e => psiElementHash(e, partySecret))

  // XOR-fold all element hashes
  let acc = Buffer.alloc(32, 0)
  for (const eh of elementHashes) {
    acc = xorBuffers(acc, eh)
  }

  const setHash = sha256(PSI_SET_TAG, acc)
  return { setHash, elementHashes }
}

function psiIntersection(hashesA: Buffer[], hashesB: Buffer[]): Buffer[] {
  const setB = new Set(hashesB.map(h => h.toString('hex')))
  return hashesA.filter(h => setB.has(h.toString('hex')))
}

function psiProofHash(setHashA: Buffer, setHashB: Buffer, intersectionSize: bigint): Buffer {
  return sha256(PSI_PROOF_TAG, setHashA, setHashB, u64le(intersectionSize))
}

interface PSIResult {
  intersection: Buffer[]
  proof_hash: Buffer
  intersection_size: number
}

function computePSI(
  setA: Buffer[],
  secretA: Buffer,
  setB: Buffer[],
  secretB: Buffer,
): PSIResult {
  const { setHash: hashA, elementHashes: ehA } = psiSetHash(setA, secretA)
  const { setHash: hashB, elementHashes: ehB } = psiSetHash(setB, secretB)

  // Both parties hash their own elements with their own secret.
  // Intersection is only possible if the same underlying element
  // was hashed with the SAME secret (i.e., both use a shared/agreed secret).
  // For the intersection test, we look for matching hashes.
  const intersection = psiIntersection(ehA, ehB)
  const proof_hash   = psiProofHash(hashA, hashB, BigInt(intersection.length))

  return { intersection, proof_hash, intersection_size: intersection.length }
}

const mainnet_ready = false

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null private-set-intersection', () => {
  it('mainnet_ready flag is false', () => {
    expect(mainnet_ready).toBe(false)
  })

  it('2 common out of 4 elements each (shared secret yields matches)', () => {
    // When both parties use the same secret the hashes of shared elements match.
    const sharedSecret = Buffer.from('shared-party-secret-32bytes-----', 'utf8').subarray(0, 32)

    const common1 = Buffer.from('element-common-1', 'utf8')
    const common2 = Buffer.from('element-common-2', 'utf8')

    const setA = [common1, common2, Buffer.from('only-in-A-1', 'utf8'), Buffer.from('only-in-A-2', 'utf8')]
    const setB = [common1, common2, Buffer.from('only-in-B-1', 'utf8'), Buffer.from('only-in-B-2', 'utf8')]

    const result = computePSI(setA, sharedSecret, setB, sharedSecret)
    expect(result.intersection_size).toBe(2)
  })

  it('empty intersection when no common elements', () => {
    const sharedSecret = Buffer.from('shared-party-secret-32bytes-----', 'utf8').subarray(0, 32)

    const setA = [Buffer.from('a-only-1', 'utf8'), Buffer.from('a-only-2', 'utf8')]
    const setB = [Buffer.from('b-only-1', 'utf8'), Buffer.from('b-only-2', 'utf8')]

    const result = computePSI(setA, sharedSecret, setB, sharedSecret)
    expect(result.intersection_size).toBe(0)
    expect(result.intersection).toHaveLength(0)
  })

  it('verify_intersection: proof hash is deterministic and non-zero', () => {
    const sharedSecret = Buffer.from('shared-party-secret-32bytes-----', 'utf8').subarray(0, 32)

    const elem = Buffer.from('single-common', 'utf8')
    const setA = [elem, Buffer.from('only-a', 'utf8')]
    const setB = [elem, Buffer.from('only-b', 'utf8')]

    const r1 = computePSI(setA, sharedSecret, setB, sharedSecret)
    const r2 = computePSI(setA, sharedSecret, setB, sharedSecret)

    expect(r1.proof_hash.equals(r2.proof_hash)).toBe(true)
    expect(r1.proof_hash.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('different party secrets → different hashes for same element (no leak)', () => {
    const secretA = Buffer.from('party-A-secret-32bytes----------', 'utf8').subarray(0, 32)
    const secretB = Buffer.from('party-B-secret-32bytes----------', 'utf8').subarray(0, 32)

    const elem = Buffer.from('same-element', 'utf8')

    const hashA = psiElementHash(elem, secretA)
    const hashB = psiElementHash(elem, secretB)

    expect(hashA.equals(hashB)).toBe(false)
  })

  it('intersection size is correct for 3 common out of 5', () => {
    const sharedSecret = Buffer.from('shared-party-secret-32bytes-----', 'utf8').subarray(0, 32)

    const common = [1, 2, 3].map(i => Buffer.from(`common-${i}`, 'utf8'))
    const onlyA  = [1, 2].map(i => Buffer.from(`only-a-${i}`, 'utf8'))
    const onlyB  = [1, 2].map(i => Buffer.from(`only-b-${i}`, 'utf8'))

    const setA = [...common, ...onlyA]
    const setB = [...common, ...onlyB]

    const result = computePSI(setA, sharedSecret, setB, sharedSecret)
    expect(result.intersection_size).toBe(3)
  })

  it('proof_hash is deterministic across two identical calls', () => {
    const sharedSecret = Buffer.from('shared-party-secret-32bytes-----', 'utf8').subarray(0, 32)

    const setA = [Buffer.from('x', 'utf8'), Buffer.from('y', 'utf8')]
    const setB = [Buffer.from('x', 'utf8'), Buffer.from('z', 'utf8')]

    const r1 = computePSI(setA, sharedSecret, setB, sharedSecret)
    const r2 = computePSI(setA, sharedSecret, setB, sharedSecret)

    expect(r1.proof_hash.equals(r2.proof_hash)).toBe(true)
    expect(r1.intersection_size).toBe(r2.intersection_size)
  })
})
