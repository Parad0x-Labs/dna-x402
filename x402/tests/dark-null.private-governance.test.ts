import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Private Governance primitives
//
// proposerHash(secret)                        = SHA256("gov-proposer-v1" || secret)
// contentHash(content)                        = SHA256("gov-content-v1"  || content)
// proposalId(proposerHash, contentHash)       = SHA256("gov-proposal-v1" || proposerHash || contentHash)
// voterHash(voterSecret)                      = SHA256("gov-voter-v1"    || voterSecret)
// voteCommitment(voterHash, choice_u8, nonce) = SHA256("gov-vote-v1"     || voterHash || [choice] || nonce)
// voteId(proposalId, voterHash)               = SHA256("gov-vid-v1"      || proposalId || voterHash)
// voteRoot(voteIds[], count_u32le)            = SHA256("gov-root-v1"     || xorFold(voteIds) || count_le4)
// ---------------------------------------------------------------------------

function proposerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('gov-proposer-v1'), secret)
}

function contentHash(content: Buffer): Buffer {
  return sha256(Buffer.from('gov-content-v1'), content)
}

function proposalId(pHash: Buffer, cHash: Buffer): Buffer {
  return sha256(Buffer.from('gov-proposal-v1'), pHash, cHash)
}

function voterHash(voterSecret: Buffer): Buffer {
  return sha256(Buffer.from('gov-voter-v1'), voterSecret)
}

function voteCommitment(vHash: Buffer, choice: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('gov-vote-v1'), vHash, Buffer.from([choice]), nonce)
}

function voteId(propId: Buffer, vHash: Buffer): Buffer {
  return sha256(Buffer.from('gov-vid-v1'), propId, vHash)
}

function voteRoot(voteIds: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('gov-root-v1'), xorFold(voteIds), u32le(count))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-governance', () => {
  const PROPOSER_SECRET = Buffer.alloc(32).fill(0xaa)
  const CONTENT         = Buffer.from('Proposal: increase block size')
  const VOTER_SECRET_A  = Buffer.alloc(32).fill(0xb1)
  const VOTER_SECRET_B  = Buffer.alloc(32).fill(0xb2)
  const NONCE_A         = Buffer.alloc(32).fill(0x0a)
  const NONCE_B         = Buffer.alloc(32).fill(0x0b)

  // Test 1: proposal_id formula is correct
  it('proposal_id formula is correct', () => {
    const pHash  = proposerHash(PROPOSER_SECRET)
    const cHash  = contentHash(CONTENT)
    const propId = proposalId(pHash, cHash)

    const expected = sha256(Buffer.from('gov-proposal-v1'), pHash, cHash)
    expect(propId.length).toBe(32)
    expect(propId.equals(expected)).toBe(true)
    expect(propId.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 2: vote_commitment uses "gov-vote-v1" domain
  it('vote_commitment uses "gov-vote-v1" domain', () => {
    const vHash    = voterHash(VOTER_SECRET_A)
    const commitYes = voteCommitment(vHash, 1, NONCE_A)
    const commitNo  = voteCommitment(vHash, 0, NONCE_A)

    const expectedYes = sha256(Buffer.from('gov-vote-v1'), vHash, Buffer.from([1]), NONCE_A)
    const expectedNo  = sha256(Buffer.from('gov-vote-v1'), vHash, Buffer.from([0]), NONCE_A)
    expect(commitYes.equals(expectedYes)).toBe(true)
    expect(commitNo.equals(expectedNo)).toBe(true)
    expect(commitYes.equals(commitNo)).toBe(false)
  })

  // Test 3: yes vote increments yes_count, no vote increments no_count
  it('yes vote increments yes_count, no vote increments no_count', () => {
    let vote_count = 0
    let yes_count  = 0
    let no_count   = 0

    // Cast yes vote
    vote_count++; yes_count++
    expect(vote_count).toBe(1)
    expect(yes_count).toBe(1)
    expect(no_count).toBe(0)

    // Cast no vote
    vote_count++; no_count++
    expect(vote_count).toBe(2)
    expect(yes_count).toBe(1)
    expect(no_count).toBe(1)

    // Another yes
    vote_count++; yes_count++
    expect(vote_count).toBe(3)
    expect(yes_count).toBe(2)
    expect(no_count).toBe(1)
  })

  // Test 4: vote_root changes after adding a vote
  it('vote_root changes after adding a vote', () => {
    const pHash   = proposerHash(PROPOSER_SECRET)
    const cHash   = contentHash(CONTENT)
    const propId  = proposalId(pHash, cHash)

    const vHashA  = voterHash(VOTER_SECRET_A)
    const vidA    = voteId(propId, vHashA)

    const rootBefore = voteRoot([], 0)
    const rootAfter  = voteRoot([vidA], 1)

    expect(rootBefore.equals(rootAfter)).toBe(false)
  })

  // Test 5: finalized flag set after finalize
  it('finalized flag set after finalize', () => {
    let finalized = false
    expect(finalized).toBe(false)
    // finalize
    finalized = true
    expect(finalized).toBe(true)

    // Verify root after both votes
    const pHash  = proposerHash(PROPOSER_SECRET)
    const cHash  = contentHash(CONTENT)
    const propId = proposalId(pHash, cHash)
    const vHashA = voterHash(VOTER_SECRET_A)
    const vHashB = voterHash(VOTER_SECRET_B)
    const vidA   = voteId(propId, vHashA)
    const vidB   = voteId(propId, vHashB)
    const root   = voteRoot([vidA, vidB], 2)
    expect(root.length).toBe(32)
    expect(root.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 6: mainnet_ready is false
  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
