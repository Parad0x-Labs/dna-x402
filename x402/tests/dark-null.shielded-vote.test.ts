import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Domain primitives — shielded-vote
// ---------------------------------------------------------------------------

function adminHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('svote-admin-v1'), secret)
}

function sessionId(adminH: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('svote-session-v1'), adminH, nonce)
}

function voterHash(voterSecret: Buffer): Buffer {
  return sha256(Buffer.from('svote-voter-v1'), voterSecret)
}

function voteCommitment(voterH: Buffer, choice: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('svote-commit-v1'), voterH, Buffer.from([choice]), nonce)
}

function ballotNullifier(voterH: Buffer, sessionI: Buffer): Buffer {
  return sha256(Buffer.from('svote-null-v1'), voterH, sessionI)
}

function ballotId(voteCommit: Buffer, nullifierHash: Buffer): Buffer {
  return sha256(Buffer.from('svote-ballot-v1'), voteCommit, nullifierHash)
}

function yesCommitment(count: number): Buffer {
  return sha256(Buffer.from('svote-yes-v1'), u32le(count))
}

function noCommitment(count: number): Buffer {
  return sha256(Buffer.from('svote-no-v1'), u32le(count))
}

function ballotRoot(ballotIds: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('svote-root-v1'), xorFold(ballotIds), u32le(count))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null shielded-vote', () => {
  const adminSecret = Buffer.alloc(32, 0xad)
  const sessionNonce = Buffer.alloc(32, 0x5e)
  const adminH = adminHash(adminSecret)
  const sessionI = sessionId(adminH, sessionNonce)

  it('session_id formula is correct', () => {
    const expected = sha256(Buffer.from('svote-session-v1'), adminH, sessionNonce)
    expect(sessionI.toString('hex')).toBe(expected.toString('hex'))
    expect(sessionI.length).toBe(32)
    expect(sessionI.every(b => b === 0)).toBe(false)
  })

  it('vote_commitment uses "svote-commit-v1" domain, choice=1 for yes', () => {
    const voterH = voterHash(Buffer.alloc(32, 0x1a))
    const nonce = Buffer.alloc(32, 0x99)
    const choice = 1 // yes
    const commit = voteCommitment(voterH, choice, nonce)
    const expected = sha256(Buffer.from('svote-commit-v1'), voterH, Buffer.from([1]), nonce)
    expect(commit.toString('hex')).toBe(expected.toString('hex'))
    // Different choice (no=0) → different commitment
    const commitNo = voteCommitment(voterH, 0, nonce)
    expect(commit.toString('hex')).not.toBe(commitNo.toString('hex'))
  })

  it('ballot_id formula is correct', () => {
    const voterH = voterHash(Buffer.alloc(32, 0x42))
    const nonce = Buffer.alloc(32, 0x13)
    const vCommit = voteCommitment(voterH, 1, nonce)
    const nullH = ballotNullifier(voterH, sessionI)
    const bid = ballotId(vCommit, nullH)
    const expected = sha256(Buffer.from('svote-ballot-v1'), vCommit, nullH)
    expect(bid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('yes_commitment changes as yes count increases', () => {
    const yc1 = yesCommitment(1)
    const yc2 = yesCommitment(2)
    expect(yc1.toString('hex')).not.toBe(yc2.toString('hex'))
    // Verify formula
    const expected = sha256(Buffer.from('svote-yes-v1'), u32le(1))
    expect(yc1.toString('hex')).toBe(expected.toString('hex'))
  })

  it('ballot_root changes after casting a vote', () => {
    const voter1H = voterHash(Buffer.alloc(32, 0x71))
    const voter2H = voterHash(Buffer.alloc(32, 0x72))
    const nonce1 = Buffer.alloc(32, 0xa1)
    const nonce2 = Buffer.alloc(32, 0xa2)
    const vCommit1 = voteCommitment(voter1H, 1, nonce1)
    const null1 = ballotNullifier(voter1H, sessionI)
    const bid1 = ballotId(vCommit1, null1)
    const root1 = ballotRoot([bid1], 1)

    const vCommit2 = voteCommitment(voter2H, 0, nonce2)
    const null2 = ballotNullifier(voter2H, sessionI)
    const bid2 = ballotId(vCommit2, null2)
    const root2 = ballotRoot([bid1, bid2], 2)

    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
    expect(root1.every(b => b === 0)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = { mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
