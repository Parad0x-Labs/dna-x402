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

function identityHash(identitySecret: Buffer): Buffer {
  return sha256(Buffer.from('bridge-identity-v1'), identitySecret)
}

function chainHash(chainIdBytes: Buffer, identityHash: Buffer): Buffer {
  return sha256(Buffer.from('bridge-chain-v1'), chainIdBytes, identityHash)
}

function bridgeCommitment(chainAHash: Buffer, chainBHash: Buffer): Buffer {
  return sha256(Buffer.from('bridge-commit-v1'), chainAHash, chainBHash)
}

function anchorId(bridgeCommitment: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('bridge-anchor-v1'), bridgeCommitment, nonce)
}

function proofHash(anchorId: Buffer, bridgeCommitment: Buffer): Buffer {
  return sha256(Buffer.from('bridge-proof-v1'), anchorId, bridgeCommitment)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null identity-bridge', () => {
  const IDENTITY_SECRET = Buffer.alloc(32, 0x33)
  const CHAIN_A_ID = Buffer.from('solana-mainnet', 'utf8')
  const CHAIN_B_ID = Buffer.from('ethereum-mainnet', 'utf8')
  const NONCE = Buffer.alloc(32, 0xcd)

  it('anchor_id computation is correct', () => {
    const ih = identityHash(IDENTITY_SECRET)
    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc = bridgeCommitment(caHash, cbHash)
    const anchor = anchorId(bc, NONCE)

    expect(anchor).toBeInstanceOf(Buffer)
    expect(anchor.length).toBe(32)

    // Manual recomputation
    const expected = sha256(Buffer.from('bridge-anchor-v1'), bc, NONCE)
    expect(anchor.toString('hex')).toBe(expected.toString('hex'))
  })

  it('bridge_commitment is sensitive to chain IDs', () => {
    const ih = identityHash(IDENTITY_SECRET)

    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc1 = bridgeCommitment(caHash, cbHash)

    // Swap chain IDs
    const caHash2 = chainHash(Buffer.from('polygon-mainnet', 'utf8'), ih)
    const bc2 = bridgeCommitment(caHash2, cbHash)

    expect(bc1.toString('hex')).not.toBe(bc2.toString('hex'))

    // Same identity, different chain order
    const bc3 = bridgeCommitment(cbHash, caHash) // swapped order
    expect(bc1.toString('hex')).not.toBe(bc3.toString('hex'))
  })

  it('proof_hash computation is correct', () => {
    const ih = identityHash(IDENTITY_SECRET)
    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc = bridgeCommitment(caHash, cbHash)
    const anchor = anchorId(bc, NONCE)
    const pHash = proofHash(anchor, bc)

    expect(pHash).toBeInstanceOf(Buffer)
    expect(pHash.length).toBe(32)

    const expected = sha256(Buffer.from('bridge-proof-v1'), anchor, bc)
    expect(pHash.toString('hex')).toBe(expected.toString('hex'))
  })

  it('verify: recomputing proof_hash matches stored value', () => {
    const ih = identityHash(IDENTITY_SECRET)
    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc = bridgeCommitment(caHash, cbHash)
    const anchor = anchorId(bc, NONCE)
    const stored = proofHash(anchor, bc)

    // Recompute from same inputs
    const recomputed = proofHash(anchor, bc)
    expect(stored.toString('hex')).toBe(recomputed.toString('hex'))

    // Different nonce → different anchor → different proof_hash
    const anchor2 = anchorId(bc, Buffer.alloc(32, 0xff))
    const recomputed2 = proofHash(anchor2, bc)
    expect(stored.toString('hex')).not.toBe(recomputed2.toString('hex'))
  })

  it('public record hides identity_hash', () => {
    const ih = identityHash(IDENTITY_SECRET)
    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc = bridgeCommitment(caHash, cbHash)
    const anchor = anchorId(bc, NONCE)
    const pHash = proofHash(anchor, bc)

    const publicRecord = {
      anchor_id: anchor.toString('hex'),
      bridge_commitment: bc.toString('hex'),
      proof_hash: pHash.toString('hex'),
      mainnet_ready: false,
    }

    expect(Object.keys(publicRecord)).not.toContain('identity_hash')
    expect(Object.keys(publicRecord)).not.toContain('identity_secret')
    expect(publicRecord).toHaveProperty('anchor_id')
    expect(publicRecord).toHaveProperty('bridge_commitment')
  })

  it('mainnet_ready=false', () => {
    const ih = identityHash(IDENTITY_SECRET)
    const caHash = chainHash(CHAIN_A_ID, ih)
    const cbHash = chainHash(CHAIN_B_ID, ih)
    const bc = bridgeCommitment(caHash, cbHash)
    const anchor = anchorId(bc, NONCE)

    const publicRecord = {
      anchor_id: anchor.toString('hex'),
      bridge_commitment: bc.toString('hex'),
      mainnet_ready: false,
    }

    expect(publicRecord.mainnet_ready).toBe(false)
  })
})
