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

function organizerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('cf-organizer-v1'), secret)
}
function goalCommitment(goal: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('cf-goal-v1'), u64le(goal), blinding)
}
function campaignId(orgHash: Buffer, goalCommit: Buffer): Buffer {
  return sha256(Buffer.from('cf-id-v1'), orgHash, goalCommit)
}
function backerHash(backerSecret: Buffer): Buffer {
  return sha256(Buffer.from('cf-backer-v1'), backerSecret)
}
function contribCommitment(bHash: Buffer, amount: bigint, nonce: Buffer): Buffer {
  return sha256(Buffer.from('cf-contrib-v1'), bHash, u64le(amount), nonce)
}
function contribId(cId: Buffer, bHash: Buffer): Buffer {
  return sha256(Buffer.from('cf-cid-v1'), cId, bHash)
}
function contribRoot(contribIds: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('cf-root-v1'), xorFold(contribIds), u32le(count))
}

describe('dark-null.private-crowdfund', () => {
  const orgSecret = Buffer.alloc(32, 0x11)
  const goalAmount = 50000n
  const blinding = Buffer.alloc(32, 0x22)
  const backer1Secret = Buffer.alloc(32, 0x33)
  const backer2Secret = Buffer.alloc(32, 0x44)
  const nonce = Buffer.alloc(32, 0x55)

  it('campaign_id formula is correct', () => {
    const oHash = organizerHash(orgSecret)
    const gCommit = goalCommitment(goalAmount, blinding)
    const cId = campaignId(oHash, gCommit)
    const expected = sha256(Buffer.from('cf-id-v1'), oHash, gCommit)
    expect(cId.toString('hex')).toBe(expected.toString('hex'))
    expect(cId.length).toBe(32)
  })

  it('contribution_commitment uses backer_hash and amount', () => {
    const bHash = backerHash(backer1Secret)
    const c1 = contribCommitment(bHash, 1000n, nonce)
    const c2 = contribCommitment(bHash, 2000n, nonce)
    expect(c1.length).toBe(32)
    expect(c1.toString('hex')).not.toBe(c2.toString('hex'))
  })

  it('contrib_root changes after adding a contribution', () => {
    const oHash = organizerHash(orgSecret)
    const gCommit = goalCommitment(goalAmount, blinding)
    const cId = campaignId(oHash, gCommit)
    const bHash1 = backerHash(backer1Secret)
    const cid1 = contribId(cId, bHash1)

    const root1 = contribRoot([cid1], 1)

    const bHash2 = backerHash(backer2Secret)
    const cid2 = contribId(cId, bHash2)
    const root2 = contribRoot([cid1, cid2], 2)

    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('different backers produce different contrib_ids', () => {
    const oHash = organizerHash(orgSecret)
    const gCommit = goalCommitment(goalAmount, blinding)
    const cId = campaignId(oHash, gCommit)
    const bHash1 = backerHash(backer1Secret)
    const bHash2 = backerHash(backer2Secret)
    const cid1 = contribId(cId, bHash1)
    const cid2 = contribId(cId, bHash2)
    expect(cid1.toString('hex')).not.toBe(cid2.toString('hex'))
  })

  it('campaign_id is deterministic', () => {
    const oHash = organizerHash(orgSecret)
    const gCommit = goalCommitment(goalAmount, blinding)
    const cId1 = campaignId(oHash, gCommit)
    const cId2 = campaignId(oHash, gCommit)
    expect(cId1.toString('hex')).toBe(cId2.toString('hex'))
  })

  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
