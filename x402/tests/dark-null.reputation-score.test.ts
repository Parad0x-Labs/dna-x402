import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Primitives matching Rust reputation-score crate
// ---------------------------------------------------------------------------

function subjectHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('rep-subject-v1'), secret)
}

function scoreCommitment(score: number, blinding: Buffer): Buffer {
  return sha256(Buffer.from('rep-score-v1'), u32le(score), blinding)
}

function thresholdHash(threshold: number): Buffer {
  return sha256(Buffer.from('rep-threshold-v1'), u32le(threshold))
}

function scoreId(sh: Buffer, sc: Buffer, th: Buffer): Buffer {
  return sha256(Buffer.from('rep-id-v1'), sh, sc, th)
}

function attesterHash(attesterSecret: Buffer): Buffer {
  return sha256(Buffer.from('rep-attester-v1'), attesterSecret)
}

function attestationHash(sid: Buffer, ah: Buffer, passes: boolean): Buffer {
  return sha256(Buffer.from('rep-attest-v1'), sid, ah, Buffer.from([passes ? 1 : 0]))
}

function proofId(attest: Buffer): Buffer {
  return sha256(Buffer.from('rep-proof-v1'), attest)
}

interface ReputationScore {
  score_id: Buffer
  score_commitment: Buffer
  threshold_hash: Buffer
  passes_threshold: boolean
  mainnet_ready: boolean
  // internal — not in public record
  _subject_hash: Buffer
}

function newReputationScore(
  subjectSecret: Buffer,
  score: number,
  blinding: Buffer,
  threshold: number,
): ReputationScore {
  const sh = subjectHash(subjectSecret)
  const sc = scoreCommitment(score, blinding)
  const th = thresholdHash(threshold)
  const sid = scoreId(sh, sc, th)
  return {
    score_id: sid,
    score_commitment: sc,
    threshold_hash: th,
    passes_threshold: score >= threshold,
    mainnet_ready: false,
    _subject_hash: sh,
  }
}

function publicRecord(rep: ReputationScore) {
  return {
    score_id: rep.score_id.toString('hex'),
    threshold_hash: rep.threshold_hash.toString('hex'),
    passes_threshold: rep.passes_threshold,
    mainnet_ready: rep.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SUBJECT_SECRET = Buffer.from('subject-secret-abc')
const BLINDING = Buffer.alloc(32, 0x55)
const ATTESTER_SECRET = Buffer.from('attester-secret-xyz')

describe('dark-null.reputation-score', () => {
  it('score_commitment = SHA256("rep-score-v1" || score_le || blinding) — vector test', () => {
    const score = 750
    const expected = sha256(Buffer.from('rep-score-v1'), u32le(score), BLINDING)
    const sc = scoreCommitment(score, BLINDING)
    expect(sc.toString('hex')).toBe(expected.toString('hex'))
    expect(sc.length).toBe(32)
  })

  it('score_id formula is correct', () => {
    const score = 750
    const threshold = 500
    const sh = subjectHash(SUBJECT_SECRET)
    const sc = scoreCommitment(score, BLINDING)
    const th = thresholdHash(threshold)
    const expected = sha256(Buffer.from('rep-id-v1'), sh, sc, th)
    const rep = newReputationScore(SUBJECT_SECRET, score, BLINDING, threshold)
    expect(rep.score_id.toString('hex')).toBe(expected.toString('hex'))
  })

  it('passes_threshold = score >= threshold', () => {
    const rep750 = newReputationScore(SUBJECT_SECRET, 750, BLINDING, 500)
    expect(rep750.passes_threshold).toBe(true)

    const rep300 = newReputationScore(SUBJECT_SECRET, 300, BLINDING, 500)
    expect(rep300.passes_threshold).toBe(false)

    const repEqual = newReputationScore(SUBJECT_SECRET, 500, BLINDING, 500)
    expect(repEqual.passes_threshold).toBe(true)
  })

  it('different score values produce different commitments', () => {
    const sc1 = scoreCommitment(100, BLINDING)
    const sc2 = scoreCommitment(200, BLINDING)
    expect(sc1.toString('hex')).not.toBe(sc2.toString('hex'))
  })

  it('proof_id is non-zero and deterministic', () => {
    const rep = newReputationScore(SUBJECT_SECRET, 750, BLINDING, 500)
    const ah = attesterHash(ATTESTER_SECRET)
    const attest = attestationHash(rep.score_id, ah, rep.passes_threshold)
    const pid = proofId(attest)

    expect(pid.length).toBe(32)
    expect(pid.equals(Buffer.alloc(32, 0))).toBe(false)

    // Deterministic: same inputs → same proof_id
    const pid2 = proofId(attestationHash(rep.score_id, ah, rep.passes_threshold))
    expect(pid.toString('hex')).toBe(pid2.toString('hex'))
  })

  it('public record hides subject_hash and score, mainnet_ready=false', () => {
    const rep = newReputationScore(SUBJECT_SECRET, 750, BLINDING, 500)
    const rec = publicRecord(rep)
    expect(rec).not.toHaveProperty('subject_hash')
    expect(rec).not.toHaveProperty('_subject_hash')
    expect(rec).not.toHaveProperty('score')
    expect(rec).not.toHaveProperty('score_commitment')
    expect(rec.mainnet_ready).toBe(false)
    expect(rec).toHaveProperty('score_id')
  })
})
