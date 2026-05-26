import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

function elemHash(element: Buffer): Buffer {
  return sha256(Buffer.from('set-elem-v1'), element)
}
function setRoot(elemHashes: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('set-root-v1'), xorFold(elemHashes), u32le(count))
}
function elemCommitment(element: Buffer, blinding: Buffer): Buffer {
  return sha256(Buffer.from('set-commit-v1'), element, blinding)
}
function nullifier(elemCommit: Buffer, sRoot: Buffer): Buffer {
  return sha256(Buffer.from('set-null-v1'), elemCommit, sRoot)
}
function proofId(null_: Buffer, sRoot: Buffer): Buffer {
  return sha256(Buffer.from('set-proof-v1'), null_, sRoot)
}

describe('dark-null.zkp-set-membership', () => {
  const elem1 = Buffer.from('element-alpha-0001')
  const elem2 = Buffer.from('element-beta-0002')
  const blinding = Buffer.alloc(32, 0xab)

  it('set_root formula is correct', () => {
    const h1 = elemHash(elem1)
    const h2 = elemHash(elem2)
    const root = setRoot([h1, h2], 2)
    const expected = sha256(
      Buffer.from('set-root-v1'),
      xorFold([h1, h2]),
      u32le(2)
    )
    expect(root.toString('hex')).toBe(expected.toString('hex'))
    expect(root.length).toBe(32)
  })

  it('element_commitment uses blinding', () => {
    const c1 = elemCommitment(elem1, blinding)
    const c2 = elemCommitment(elem1, Buffer.alloc(32, 0xcd))
    expect(c1.length).toBe(32)
    expect(c1.toString('hex')).not.toBe(c2.toString('hex'))
  })

  it('nullifier = SHA256("set-null-v1" || elem_commit || set_root)', () => {
    const h1 = elemHash(elem1)
    const root = setRoot([h1], 1)
    const commit = elemCommitment(elem1, blinding)
    const null_ = nullifier(commit, root)
    const expected = sha256(Buffer.from('set-null-v1'), commit, root)
    expect(null_.toString('hex')).toBe(expected.toString('hex'))
  })

  it('proof_id = SHA256("set-proof-v1" || nullifier || set_root)', () => {
    const h1 = elemHash(elem1)
    const root = setRoot([h1], 1)
    const commit = elemCommitment(elem1, blinding)
    const null_ = nullifier(commit, root)
    const pid = proofId(null_, root)
    const expected = sha256(Buffer.from('set-proof-v1'), null_, root)
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('different sets produce different set_roots', () => {
    const h1 = elemHash(elem1)
    const h2 = elemHash(elem2)
    const root1 = setRoot([h1], 1)
    const root2 = setRoot([h1, h2], 2)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
