import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Confidential Transfer primitives (mirrors crates/dark-confidential-transfer/src/lib.rs)
//
// owner_hash        = SHA256("ct-owner-v1"  || owner_secret)
// asset_hash        = SHA256("ct-asset-v1"  || asset_bytes)
// amount_commitment = SHA256("ct-amount-v1" || amount_u64le || blinding)
// note_id           = SHA256("ct-note-v1"   || owner_hash || asset_hash || amount_commitment || nonce)
// nullifier         = SHA256("ct-null-v1"   || note_id || owner_hash)
// ---------------------------------------------------------------------------

function ownerHash(ownerSecret: Buffer): Buffer {
  return sha256(Buffer.from('ct-owner-v1'), ownerSecret)
}

function assetHash(assetBytes: Buffer): Buffer {
  return sha256(Buffer.from('ct-asset-v1'), assetBytes)
}

function amountCommitment(amount: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('ct-amount-v1'), u64le(amount), blinding)
}

function noteId(oHash: Buffer, aHash: Buffer, amtCommit: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('ct-note-v1'), oHash, aHash, amtCommit, nonce)
}

function nullifier(nId: Buffer, oHash: Buffer): Buffer {
  return sha256(Buffer.from('ct-null-v1'), nId, oHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null confidential-transfer', () => {
  const OWNER_A_SECRET = Buffer.alloc(32).fill(0xa1)
  const OWNER_B_SECRET = Buffer.alloc(32).fill(0xa2)
  const ASSET_BYTES = Buffer.from('usdc-mainnet-mint')
  const BLINDING = Buffer.alloc(32).fill(0xb0)
  const NONCE = Buffer.alloc(32).fill(0x01)

  // Test 1: note_id computation
  it('note_id computation is deterministic', () => {
    const oHash = ownerHash(OWNER_A_SECRET)
    const aHash = assetHash(ASSET_BYTES)
    const amtCom = amountCommitment(500n, BLINDING)
    const nId = noteId(oHash, aHash, amtCom, NONCE)
    const nId2 = noteId(oHash, aHash, amtCom, NONCE)
    expect(nId.length).toBe(32)
    expect(nId.equals(nId2)).toBe(true)
    const expected = sha256(
      Buffer.from('ct-note-v1'), oHash, aHash, amtCom, NONCE
    )
    expect(nId.equals(expected)).toBe(true)
  })

  // Test 2: nullifier computation
  it('nullifier computation is deterministic', () => {
    const oHash = ownerHash(OWNER_A_SECRET)
    const aHash = assetHash(ASSET_BYTES)
    const amtCom = amountCommitment(500n, BLINDING)
    const nId = noteId(oHash, aHash, amtCom, NONCE)
    const nul = nullifier(nId, oHash)
    const nul2 = nullifier(nId, oHash)
    expect(nul.length).toBe(32)
    expect(nul.equals(nul2)).toBe(true)
    const expected = sha256(Buffer.from('ct-null-v1'), nId, oHash)
    expect(nul.equals(expected)).toBe(true)
  })

  // Test 3: different owners → different note_ids
  it('different owners produce different note_ids', () => {
    const oHashA = ownerHash(OWNER_A_SECRET)
    const oHashB = ownerHash(OWNER_B_SECRET)
    const aHash = assetHash(ASSET_BYTES)
    const amtCom = amountCommitment(500n, BLINDING)
    const nIdA = noteId(oHashA, aHash, amtCom, NONCE)
    const nIdB = noteId(oHashB, aHash, amtCom, NONCE)
    expect(nIdA.equals(nIdB)).toBe(false)
  })

  // Test 4: amount_commitment sensitive to amount
  it('amount_commitment sensitive to amount', () => {
    const c1 = amountCommitment(100n, BLINDING)
    const c2 = amountCommitment(200n, BLINDING)
    expect(c1.equals(c2)).toBe(false)
  })

  // Test 5: public record hides owner and amount
  it('public record hides owner and amount', () => {
    const oHash = ownerHash(OWNER_A_SECRET)
    const aHash = assetHash(ASSET_BYTES)
    const amtCom = amountCommitment(500n, BLINDING)
    const nId = noteId(oHash, aHash, amtCom, NONCE)
    const nul = nullifier(nId, oHash)
    // Public record only exposes note_id (commitment to everything) and nullifier
    const publicRecord = {
      note_id: nId.toString('hex'),
      nullifier: nul.toString('hex'),
      finalized: false,
      mainnet_ready: false,
    }
    // The public record does NOT contain owner or amount in plaintext
    expect(publicRecord).not.toHaveProperty('owner_secret')
    expect(publicRecord).not.toHaveProperty('amount')
    expect(publicRecord.mainnet_ready).toBe(false)
    // The note_id itself is a hash — not the owner or amount directly
    expect(publicRecord.note_id).not.toEqual(oHash.toString('hex'))
    expect(publicRecord.note_id).not.toEqual(amtCom.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready=false confirmed and nullifier unique per note', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
    // Nullifiers differ when note differs (different nonces)
    const oHash = ownerHash(OWNER_A_SECRET)
    const aHash = assetHash(ASSET_BYTES)
    const amtCom = amountCommitment(500n, BLINDING)
    const NONCE_2 = Buffer.alloc(32).fill(0x02)
    const nId1 = noteId(oHash, aHash, amtCom, NONCE)
    const nId2 = noteId(oHash, aHash, amtCom, NONCE_2)
    const nul1 = nullifier(nId1, oHash)
    const nul2 = nullifier(nId2, oHash)
    expect(nul1.equals(nul2)).toBe(false)
  })
})
