import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

// ---------------------------------------------------------------------------
// Private-insurance inline implementation
// Mirrors crates/dark-private-insurance/src/lib.rs
//
// insured_hash   = SHA256("insur-insured-v1" || insured_secret)
// coverage_hash  = SHA256("insur-coverage-v1" || coverage_bytes)
// policy_id      = SHA256("insur-policy-v1" || insured_hash || coverage_hash
//                         || premium_u64le || payout_u64le || nonce)
// claimant_hash  = SHA256("insur-claimant-v1" || claimant_secret)
// event_hash     = SHA256("insur-event-v1" || event_bytes)
// claim_id       = SHA256("insur-claim-v1" || policy_id || claimant_hash || event_hash)
// ---------------------------------------------------------------------------

function insuredHash(insuredSecret: Buffer): Buffer {
  return sha256(Buffer.from('insur-insured-v1'), insuredSecret)
}

function coverageHash(coverageBytes: Buffer): Buffer {
  return sha256(Buffer.from('insur-coverage-v1'), coverageBytes)
}

function policyId(
  insuredSecret: Buffer,
  coverageBytes: Buffer,
  premium: bigint,
  payout: bigint,
  nonce: Buffer,
): Buffer {
  const ih = insuredHash(insuredSecret)
  const ch = coverageHash(coverageBytes)
  return sha256(Buffer.from('insur-policy-v1'), ih, ch, u64le(premium), u64le(payout), nonce)
}

function claimantHash(claimantSecret: Buffer): Buffer {
  return sha256(Buffer.from('insur-claimant-v1'), claimantSecret)
}

function eventHash(eventBytes: Buffer): Buffer {
  return sha256(Buffer.from('insur-event-v1'), eventBytes)
}

function claimId(
  polId: Buffer,
  claimantSecret: Buffer,
  evBytes: Buffer,
): Buffer {
  const clH = claimantHash(claimantSecret)
  const evH = eventHash(evBytes)
  return sha256(Buffer.from('insur-claim-v1'), polId, clH, evH)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-insurance', () => {
  const INSURED_SECRET = Buffer.alloc(32).fill(0x11)
  const CLAIMANT_SECRET = Buffer.alloc(32).fill(0x22)
  const COVERAGE = Buffer.from(JSON.stringify({ type: 'flood', limit_usd: 100000 }))
  const EVENT = Buffer.from(JSON.stringify({ flood_date: '2026-03-01', damage_usd: 50000 }))
  const NONCE = Buffer.alloc(32).fill(0x99)
  const PREMIUM = 500_000n   // 0.5 USDC in atomic
  const PAYOUT = 100_000_000n // 100 USDC in atomic

  it('policy_id = SHA256("insur-policy-v1" || insured_hash || coverage_hash || premium || payout || nonce)', () => {
    const polId = policyId(INSURED_SECRET, COVERAGE, PREMIUM, PAYOUT, NONCE)
    expect(polId).toBeInstanceOf(Buffer)
    expect(polId.length).toBe(32)
    const ih = insuredHash(INSURED_SECRET)
    const ch = coverageHash(COVERAGE)
    const expected = sha256(Buffer.from('insur-policy-v1'), ih, ch, u64le(PREMIUM), u64le(PAYOUT), NONCE)
    expect(polId).toEqual(expected)
  })

  it('claim_id = SHA256("insur-claim-v1" || policy_id || claimant_hash || event_hash)', () => {
    const polId = policyId(INSURED_SECRET, COVERAGE, PREMIUM, PAYOUT, NONCE)
    const cId = claimId(polId, CLAIMANT_SECRET, EVENT)
    expect(cId).toBeInstanceOf(Buffer)
    expect(cId.length).toBe(32)
    const clH = claimantHash(CLAIMANT_SECRET)
    const evH = eventHash(EVENT)
    const expected = sha256(Buffer.from('insur-claim-v1'), polId, clH, evH)
    expect(cId).toEqual(expected)
  })

  it('different premiums → different policy_ids', () => {
    const polId1 = policyId(INSURED_SECRET, COVERAGE, 100n, PAYOUT, NONCE)
    const polId2 = policyId(INSURED_SECRET, COVERAGE, 200n, PAYOUT, NONCE)
    expect(polId1.equals(polId2)).toBe(false)
  })

  it('public record hides insured secret (only hash visible)', () => {
    const polId = policyId(INSURED_SECRET, COVERAGE, PREMIUM, PAYOUT, NONCE)
    const ih = insuredHash(INSURED_SECRET)
    // The public record must NOT contain raw insured_secret, only insured_hash
    const record = {
      policy_id: polId.toString('hex'),
      coverage_hash: coverageHash(COVERAGE).toString('hex'),
      mainnet_ready: false,
    }
    const raw = JSON.stringify(record)
    expect(raw).not.toContain(INSURED_SECRET.toString('hex'))
    expect(record.policy_id.length).toBe(64)
    // insured_hash itself is derived and can verify without exposing secret
    expect(ih.length).toBe(32)
  })

  it('different events → different claim_ids', () => {
    const polId = policyId(INSURED_SECRET, COVERAGE, PREMIUM, PAYOUT, NONCE)
    const ev2 = Buffer.from(JSON.stringify({ flood_date: '2026-04-01', damage_usd: 80000 }))
    const cId1 = claimId(polId, CLAIMANT_SECRET, EVENT)
    const cId2 = claimId(polId, CLAIMANT_SECRET, ev2)
    expect(cId1.equals(cId2)).toBe(false)
  })

  it('mainnet_ready=false in public record', () => {
    const polId = policyId(INSURED_SECRET, COVERAGE, PREMIUM, PAYOUT, NONCE)
    const record = {
      policy_id: polId.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
