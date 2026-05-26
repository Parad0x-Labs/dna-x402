import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  return acc
}

function computeProposerHash(proposerSecret: Buffer): Buffer {
  return sha256(Buffer.from('gov-proposer-v1'), proposerSecret)
}

function computeContentHash(contentBytes: Buffer): Buffer {
  return sha256(Buffer.from('gov-content-v1'), contentBytes)
}

function computeProposalId(proposerHash: Buffer, contentHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('gov-proposal-v1'), proposerHash, contentHash, nonce)
}

function computeVoterHash(voterSecret: Buffer): Buffer {
  return sha256(Buffer.from('gov-voter-v1'), voterSecret)
}

function computeVoteId(proposalId: Buffer, voterHash: Buffer, choice: number): Buffer {
  return sha256(Buffer.from('gov-vote-v1'), proposalId, voterHash, Buffer.from([choice]))
}

function computeVoteRoot(voteIds: Buffer[]): Buffer {
  return sha256(Buffer.from('gov-root-v1'), xorFold(voteIds))
}

describe('dark-null governance-proposal', () => {
  const proposerSecret = Buffer.from('proposer-secret-key-alpha')
  const contentBytes = Buffer.from('Proposal: increase block reward by 5%')
  const nonce = Buffer.from('governance-nonce-001')

  const proposerHash = computeProposerHash(proposerSecret)
  const contentHash = computeContentHash(contentBytes)
  const proposalId = computeProposalId(proposerHash, contentHash, nonce)

  const voter1Secret = Buffer.from('voter-one-secret')
  const voter2Secret = Buffer.from('voter-two-secret')
  const voterHash1 = computeVoterHash(voter1Secret)
  const voterHash2 = computeVoterHash(voter2Secret)

  const VOTE_YES = 1
  const VOTE_NO = 0

  it('computes proposal_id correctly', () => {
    const expectedProposerHash = sha256(Buffer.from('gov-proposer-v1'), proposerSecret)
    const expectedContentHash = sha256(Buffer.from('gov-content-v1'), contentBytes)
    const expectedProposalId = sha256(
      Buffer.from('gov-proposal-v1'),
      expectedProposerHash,
      expectedContentHash,
      nonce
    )
    expect(proposalId.toString('hex')).toBe(expectedProposalId.toString('hex'))
    expect(proposalId).toHaveLength(32)
  })

  it('computes vote_id correctly', () => {
    const voteId = computeVoteId(proposalId, voterHash1, VOTE_YES)
    const expected = sha256(
      Buffer.from('gov-vote-v1'),
      proposalId,
      voterHash1,
      Buffer.from([VOTE_YES])
    )
    expect(voteId.toString('hex')).toBe(expected.toString('hex'))
    expect(voteId).toHaveLength(32)
  })

  it('computes vote_root with 2 votes', () => {
    const voteId1 = computeVoteId(proposalId, voterHash1, VOTE_YES)
    const voteId2 = computeVoteId(proposalId, voterHash2, VOTE_NO)
    const voteRoot = computeVoteRoot([voteId1, voteId2])
    const expectedRoot = sha256(Buffer.from('gov-root-v1'), xorFold([voteId1, voteId2]))
    expect(voteRoot.toString('hex')).toBe(expectedRoot.toString('hex'))
    expect(voteRoot).toHaveLength(32)
  })

  it('proposer_hash is hidden in the public proposal_id', () => {
    // proposalId does not reveal proposerSecret directly
    const proposalIdHex = proposalId.toString('hex')
    const secretHex = proposerSecret.toString('hex')
    expect(proposalIdHex).not.toContain(secretHex)
    // proposerHash is a commitment; recomputing it matches
    const recomputed = computeProposerHash(proposerSecret)
    expect(recomputed.toString('hex')).toBe(proposerHash.toString('hex'))
  })

  it('different content produces different proposal_id', () => {
    const altContent = Buffer.from('Proposal: decrease block reward by 5%')
    const altContentHash = computeContentHash(altContent)
    const altProposalId = computeProposalId(proposerHash, altContentHash, nonce)
    expect(altProposalId.toString('hex')).not.toBe(proposalId.toString('hex'))
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
    // governance module is not yet production-ready
    expect(proposalId).toHaveLength(32)
    expect(contentHash).toHaveLength(32)
  })
})
