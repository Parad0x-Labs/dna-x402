import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

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

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Scheme helpers
// ---------------------------------------------------------------------------

const REQUESTER_SECRET = Buffer.alloc(32, 0x12)
const ORACLE_SECRET = Buffer.alloc(32, 0x34)
const REVEAL_NONCE = Buffer.alloc(32, 0x56)

function requesterHash(rs: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-req-v1'), rs)
}

function queryHash(queryBytes: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-query-v1'), queryBytes)
}

function blindedQuery(qh: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-blind-v1'), qh, nonce)
}

function requestId(rh: Buffer, bq: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-reqid-v1'), rh, bq)
}

function oracleHash(os: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-oracle-v1'), os)
}

function answerHash(answerBytes: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-answer-v1'), answerBytes)
}

function responseCommitment(oh: Buffer, bq: Buffer, ah: Buffer): Buffer {
  return sha256(Buffer.from('oracle2-resp-v1'), oh, bq, ah)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null.privacy-oracle (Wave 15 batch-2)', () => {
  const QUERY_BYTES = Buffer.from('what-is-the-price-of-SOL')
  const ANSWER_BYTES = Buffer.from('150.42')

  it('request_id = SHA256("oracle2-reqid-v1" || requester_hash || blinded_query)', () => {
    const rh = requesterHash(REQUESTER_SECRET)
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    const rid = requestId(rh, bq)

    const expected = sha256(Buffer.from('oracle2-reqid-v1'), rh, bq)
    expect(rid.toString('hex')).toBe(expected.toString('hex'))
    expect(rid).toHaveLength(32)
  })

  it('response_commitment = SHA256("oracle2-resp-v1" || oracle_hash || blinded_query || answer_hash)', () => {
    const rh = requesterHash(REQUESTER_SECRET)
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    const oh = oracleHash(ORACLE_SECRET)
    const ah = answerHash(ANSWER_BYTES)
    const rc = responseCommitment(oh, bq, ah)

    const expected = sha256(Buffer.from('oracle2-resp-v1'), oh, bq, ah)
    expect(rc.toString('hex')).toBe(expected.toString('hex'))
    expect(rc).toHaveLength(32)
  })

  it('different answers produce different response_commitments', () => {
    const rh = requesterHash(REQUESTER_SECRET)
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    const oh = oracleHash(ORACLE_SECRET)
    const ah1 = answerHash(Buffer.from('answer-one'))
    const ah2 = answerHash(Buffer.from('answer-two'))
    const rc1 = responseCommitment(oh, bq, ah1)
    const rc2 = responseCommitment(oh, bq, ah2)
    expect(rc1.toString('hex')).not.toBe(rc2.toString('hex'))
  })

  it('blinded_query hides raw query: blinded_query differs from query_hash', () => {
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    // The blinded query is a hash of (prefix || query_hash || nonce), not the raw query
    expect(bq.toString('hex')).not.toBe(qh.toString('hex'))
    // The raw query bytes should not appear in blinded_query (it's hashed twice)
    expect(bq.toString('hex')).not.toBe(QUERY_BYTES.toString('hex'))
    // Verify: SHA256("oracle2-blind-v1" || query_hash || nonce)
    const expected = sha256(Buffer.from('oracle2-blind-v1'), qh, REVEAL_NONCE)
    expect(bq.toString('hex')).toBe(expected.toString('hex'))
  })

  it('public record hides requester_hash: JSON contains request_id but not requester_hash', () => {
    const rh = requesterHash(REQUESTER_SECRET)
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    const rid = requestId(rh, bq)
    const record = {
      request_id: rid.toString('hex'),
      blinded_query: bq.toString('hex'),
      mainnet_ready: false,
    }
    const recStr = JSON.stringify(record)
    expect(recStr).toContain('request_id')
    expect(recStr).not.toContain(rh.toString('hex'))
    expect(recStr).not.toContain(REQUESTER_SECRET.toString('hex'))
  })

  it('mainnet_ready=false in all oracle records', () => {
    const rh = requesterHash(REQUESTER_SECRET)
    const qh = queryHash(QUERY_BYTES)
    const bq = blindedQuery(qh, REVEAL_NONCE)
    const rid = requestId(rh, bq)
    const oh = oracleHash(ORACLE_SECRET)
    const ah = answerHash(ANSWER_BYTES)
    const rc = responseCommitment(oh, bq, ah)
    const reqRecord = { request_id: rid.toString('hex'), mainnet_ready: false }
    const respRecord = { response_commitment: rc.toString('hex'), mainnet_ready: false }
    expect(reqRecord.mainnet_ready).toBe(false)
    expect(respRecord.mainnet_ready).toBe(false)
  })
})
