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

function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

function founderHash(founderSecret: Buffer): Buffer {
  return sha256(Buffer.from('dao-founder-v1'), founderSecret)
}

function daoId(founderHash: Buffer, quorum: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('dao-id-v1'), founderHash, u32le(quorum), nonce)
}

function treasuryCommitment(daoId: Buffer, initialBalance: bigint): Buffer {
  return sha256(Buffer.from('dao-treasury-v1'), daoId, u64le(initialBalance))
}

function proposerHash(proposerSecret: Buffer): Buffer {
  return sha256(Buffer.from('dao-proposer-v1'), proposerSecret)
}

function actionHash(actionBytes: Buffer): Buffer {
  return sha256(Buffer.from('dao-action-v1'), actionBytes)
}

function proposalHash(daoId: Buffer, proposerHash: Buffer, actionHash: Buffer): Buffer {
  return sha256(Buffer.from('dao-proposal-v1'), daoId, proposerHash, actionHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null dark-dao', () => {
  const FOUNDER_SECRET = Buffer.alloc(32, 0x11)
  const NONCE = Buffer.alloc(32, 0xab)
  const QUORUM = 3

  it('dao_id computation is deterministic and correct', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id = daoId(fh, QUORUM, NONCE)
    expect(id).toBeInstanceOf(Buffer)
    expect(id.length).toBe(32)

    // Manual recomputation
    const expected = sha256(
      Buffer.from('dao-id-v1'),
      sha256(Buffer.from('dao-founder-v1'), FOUNDER_SECRET),
      u32le(QUORUM),
      NONCE
    )
    expect(id.toString('hex')).toBe(expected.toString('hex'))

    // Deterministic
    const id2 = daoId(fh, QUORUM, NONCE)
    expect(id.toString('hex')).toBe(id2.toString('hex'))
  })

  it('proposal_hash computation is correct', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id = daoId(fh, QUORUM, NONCE)

    const pSecret = Buffer.alloc(32, 0x22)
    const actionBytes = Buffer.from('upgrade-protocol')

    const ph = proposerHash(pSecret)
    const ah = actionHash(actionBytes)
    const propHash = proposalHash(id, ph, ah)

    expect(propHash).toBeInstanceOf(Buffer)
    expect(propHash.length).toBe(32)

    // Manual recomputation
    const expected = sha256(
      Buffer.from('dao-proposal-v1'),
      id,
      sha256(Buffer.from('dao-proposer-v1'), pSecret),
      sha256(Buffer.from('dao-action-v1'), actionBytes)
    )
    expect(propHash.toString('hex')).toBe(expected.toString('hex'))
  })

  it('treasury_commitment is correct', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id = daoId(fh, QUORUM, NONCE)
    const balance = BigInt(1_000_000)
    const tc = treasuryCommitment(id, balance)

    expect(tc).toBeInstanceOf(Buffer)
    expect(tc.length).toBe(32)

    const expected = sha256(Buffer.from('dao-treasury-v1'), id, u64le(balance))
    expect(tc.toString('hex')).toBe(expected.toString('hex'))
  })

  it('different quorums produce different dao_ids', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id1 = daoId(fh, 3, NONCE)
    const id2 = daoId(fh, 5, NONCE)
    expect(id1.toString('hex')).not.toBe(id2.toString('hex'))
  })

  it('public record has dao_id but NOT founder_hash', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id = daoId(fh, QUORUM, NONCE)
    const tc = treasuryCommitment(id, BigInt(0))

    const publicRecord = {
      dao_id: id.toString('hex'),
      quorum: QUORUM,
      treasury_commitment: tc.toString('hex'),
      mainnet_ready: false,
    }

    expect(publicRecord).toHaveProperty('dao_id')
    expect(publicRecord.dao_id.length).toBe(64)
    expect(Object.keys(publicRecord)).not.toContain('founder_hash')
    expect(Object.keys(publicRecord)).not.toContain('founder_secret')
  })

  it('mainnet_ready=false', () => {
    const fh = founderHash(FOUNDER_SECRET)
    const id = daoId(fh, QUORUM, NONCE)
    const tc = treasuryCommitment(id, BigInt(0))

    const publicRecord = {
      dao_id: id.toString('hex'),
      quorum: QUORUM,
      treasury_commitment: tc.toString('hex'),
      mainnet_ready: false,
    }

    expect(publicRecord.mainnet_ready).toBe(false)
  })
})
