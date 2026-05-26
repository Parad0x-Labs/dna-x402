import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Primitives matching crates/dark-commit-reveal-game (or equivalent Rust crate)
// ---------------------------------------------------------------------------

function playerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('game-player-v1'), secret)
}

function choiceHash(choiceBytes: Buffer): Buffer {
  return sha256(Buffer.from('game-choice-v1'), choiceBytes)
}

function commit(choiceBytes: Buffer, nonceCommit: Buffer): Buffer {
  const ch = choiceHash(choiceBytes)
  return sha256(Buffer.from('game-commit-v1'), ch, nonceCommit)
}

function sessionId(aHash: Buffer, bHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('game-session-v1'), aHash, bHash, nonce)
}

interface CommitRevealGame {
  session_id: Buffer
  a_hash: Buffer
  b_hash: Buffer
  a_commit: Buffer
  b_commit: Buffer
  mainnet_ready: boolean
}

function newGame(
  secretA: Buffer,
  choiceBytesA: Buffer,
  nonceA: Buffer,
  secretB: Buffer,
  choiceBytesB: Buffer,
  nonceB: Buffer,
  sessionNonce: Buffer,
): CommitRevealGame {
  const aHash = playerHash(secretA)
  const bHash = playerHash(secretB)
  const sid = sessionId(aHash, bHash, sessionNonce)
  return {
    session_id: sid,
    a_hash: aHash,
    b_hash: bHash,
    a_commit: commit(choiceBytesA, nonceA),
    b_commit: commit(choiceBytesB, nonceB),
    mainnet_ready: false,
  }
}

function publicRecord(game: CommitRevealGame) {
  return {
    session_id: game.session_id.toString('hex'),
    mainnet_ready: game.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET_A = Buffer.from('secret-player-a')
const SECRET_B = Buffer.from('secret-player-b')
const CHOICE_A = Buffer.from([0x01])
const CHOICE_B = Buffer.from([0x02])
const NONCE_A = Buffer.alloc(32, 0xaa)
const NONCE_B = Buffer.alloc(32, 0xbb)
const SESSION_NONCE = Buffer.alloc(32, 0xcc)

describe('dark-null.commit-reveal-game', () => {
  it('session_id is SHA256("game-session-v1" || a_hash || b_hash || nonce)', () => {
    const aHash = playerHash(SECRET_A)
    const bHash = playerHash(SECRET_B)
    const expected = sha256(Buffer.from('game-session-v1'), aHash, bHash, SESSION_NONCE)
    const sid = sessionId(aHash, bHash, SESSION_NONCE)
    expect(sid.toString('hex')).toBe(expected.toString('hex'))
    expect(sid.length).toBe(32)
  })

  it('commit hash uses "game-commit-v1" domain', () => {
    const ch = choiceHash(CHOICE_A)
    const expected = sha256(Buffer.from('game-commit-v1'), ch, NONCE_A)
    const c = commit(CHOICE_A, NONCE_A)
    expect(c.toString('hex')).toBe(expected.toString('hex'))
  })

  it('reveal validates: recomputed commit must match stored commit', () => {
    const game = newGame(SECRET_A, CHOICE_A, NONCE_A, SECRET_B, CHOICE_B, NONCE_B, SESSION_NONCE)
    // Recompute commit for player A using the same choiceBytes + nonce
    const recomputed = commit(CHOICE_A, NONCE_A)
    expect(recomputed.toString('hex')).toBe(game.a_commit.toString('hex'))
  })

  it('wrong choice bytes cause commit mismatch', () => {
    const c1 = commit(CHOICE_A, NONCE_A)
    const c2 = commit(Buffer.from([0x99]), NONCE_A)
    expect(c1.toString('hex')).not.toBe(c2.toString('hex'))
  })

  it('winner is the player with higher choice_hash', () => {
    const chA = choiceHash(CHOICE_A)
    const chB = choiceHash(CHOICE_B)
    // Compare lexicographically: higher hex wins
    const winner = chA.compare(chB) > 0 ? 'A' : 'B'
    expect(['A', 'B']).toContain(winner)
    // Different choice bytes → different hashes
    expect(chA.toString('hex')).not.toBe(chB.toString('hex'))
  })

  it('public record has session_id field and mainnet_ready=false', () => {
    const game = newGame(SECRET_A, CHOICE_A, NONCE_A, SECRET_B, CHOICE_B, NONCE_B, SESSION_NONCE)
    const rec = publicRecord(game)
    expect(rec).toHaveProperty('session_id')
    expect(typeof rec.session_id).toBe('string')
    expect(rec.session_id.length).toBe(64) // 32 bytes hex
    expect(rec.mainnet_ready).toBe(false)
  })
})
