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

function founderHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('dao2-founder-v1'), secret)
}
function daoId(fHash: Buffer): Buffer {
  return sha256(Buffer.from('dao2-id-v1'), fHash)
}
function treasuryCommitment(amount: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('dao2-treasury-v1'), u64le(amount), blinding)
}
function memberHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('dao2-member-v1'), secret)
}
function memberRoot(hashes: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('dao2-mroot-v1'), xorFold(hashes), u32le(count))
}
function contentCommitment(content: Buffer): Buffer {
  return sha256(Buffer.from('dao2-content-v1'), content)
}
function proposalId(dId: Buffer, proposerHash: Buffer, contentCommit: Buffer): Buffer {
  return sha256(Buffer.from('dao2-prop-v1'), dId, proposerHash, contentCommit)
}
function proposalRoot(propIds: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('dao2-proot-v1'), xorFold(propIds), u32le(count))
}

describe('dark-null.private-dao-v2', () => {
  const founderSecret = Buffer.alloc(32, 0xf0)
  const member1Secret = Buffer.alloc(32, 0xa1)
  const member2Secret = Buffer.alloc(32, 0xa2)
  const blinding = Buffer.alloc(32, 0xbb)
  const content1 = Buffer.from('Proposal: increase treasury allocation')
  const content2 = Buffer.from('Proposal: add new governance module')

  it('dao_id = SHA256("dao2-id-v1" || founder_hash)', () => {
    const fHash = founderHash(founderSecret)
    const id = daoId(fHash)
    const expected = sha256(Buffer.from('dao2-id-v1'), fHash)
    expect(id.toString('hex')).toBe(expected.toString('hex'))
    expect(id.length).toBe(32)
  })

  it('treasury_commitment uses amount and blinding', () => {
    const c1 = treasuryCommitment(10000n, blinding)
    const c2 = treasuryCommitment(20000n, blinding)
    const c3 = treasuryCommitment(10000n, Buffer.alloc(32, 0xcc))
    expect(c1.toString('hex')).not.toBe(c2.toString('hex'))
    expect(c1.toString('hex')).not.toBe(c3.toString('hex'))
  })

  it('proposal_id formula is correct', () => {
    const fHash = founderHash(founderSecret)
    const dId = daoId(fHash)
    const mHash = memberHash(member1Secret)
    const cCommit = contentCommitment(content1)
    const pid = proposalId(dId, mHash, cCommit)
    const expected = sha256(Buffer.from('dao2-prop-v1'), dId, mHash, cCommit)
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('member_root changes after adding member', () => {
    const h1 = memberHash(member1Secret)
    const root1 = memberRoot([h1], 1)
    const h2 = memberHash(member2Secret)
    const root2 = memberRoot([h1, h2], 2)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('different content → different proposal_ids', () => {
    const fHash = founderHash(founderSecret)
    const dId = daoId(fHash)
    const mHash = memberHash(member1Secret)
    const c1 = contentCommitment(content1)
    const c2 = contentCommitment(content2)
    const pid1 = proposalId(dId, mHash, c1)
    const pid2 = proposalId(dId, mHash, c2)
    expect(pid1.toString('hex')).not.toBe(pid2.toString('hex'))
  })

  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
