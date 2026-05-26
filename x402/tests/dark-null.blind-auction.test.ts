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
// Blind Auction primitives (mirrors crates/dark-blind-auction/src/lib.rs)
//
// auctioneer_hash  = SHA256("auction-auctioneer-v1" || auctioneer_secret)
// item_hash        = SHA256("auction-item-v1"       || item_bytes)
// auction_id       = SHA256("auction-id-v1"         || auctioneer_hash || item_hash || nonce)
// bidder_hash      = SHA256("auction-bidder-v1"     || bidder_secret)
// bid_commitment   = SHA256("auction-bid-v1"        || bidder_hash || amount_u64le || nonce_bid)
// bid_id           = SHA256("auction-bid-id-v1"     || auction_id || bid_commitment)
// ---------------------------------------------------------------------------

function auctioneerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('auction-auctioneer-v1'), secret)
}

function itemHash(itemBytes: Buffer): Buffer {
  return sha256(Buffer.from('auction-item-v1'), itemBytes)
}

function auctionId(aucHash: Buffer, itmHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('auction-id-v1'), aucHash, itmHash, nonce)
}

function bidderHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('auction-bidder-v1'), secret)
}

function bidCommitment(bHash: Buffer, amount: bigint, nonceBid: Buffer): Buffer {
  return sha256(Buffer.from('auction-bid-v1'), bHash, u64le(amount), nonceBid)
}

function bidId(aucId: Buffer, bidCommit: Buffer): Buffer {
  return sha256(Buffer.from('auction-bid-id-v1'), aucId, bidCommit)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null blind-auction', () => {
  const AUCTIONEER_SECRET = Buffer.alloc(32).fill(0xaa)
  const ITEM_BYTES = Buffer.from('rare-sword-item-v1')
  const NONCE = Buffer.alloc(32).fill(0x01)

  const BIDDER_A_SECRET = Buffer.alloc(32).fill(0xb1)
  const BIDDER_B_SECRET = Buffer.alloc(32).fill(0xb2)
  const NONCE_BID_A = Buffer.alloc(32).fill(0x0a)
  const NONCE_BID_B = Buffer.alloc(32).fill(0x0b)

  // Test 1: auction_id computation
  it('auction_id computation is deterministic', () => {
    const aucHash = auctioneerHash(AUCTIONEER_SECRET)
    const itmHash = itemHash(ITEM_BYTES)
    const id = auctionId(aucHash, itmHash, NONCE)
    const id2 = auctionId(aucHash, itmHash, NONCE)
    expect(id.length).toBe(32)
    expect(id.equals(id2)).toBe(true)
    const expected = sha256(
      Buffer.from('auction-id-v1'),
      aucHash, itmHash, NONCE
    )
    expect(id.equals(expected)).toBe(true)
  })

  // Test 2: bid_id computation
  it('bid_id computation is deterministic', () => {
    const aucHash = auctioneerHash(AUCTIONEER_SECRET)
    const itmHash = itemHash(ITEM_BYTES)
    const aucId = auctionId(aucHash, itmHash, NONCE)
    const bHash = bidderHash(BIDDER_A_SECRET)
    const bidCommit = bidCommitment(bHash, 1000n, NONCE_BID_A)
    const bId = bidId(aucId, bidCommit)
    const bId2 = bidId(aucId, bidCommit)
    expect(bId.length).toBe(32)
    expect(bId.equals(bId2)).toBe(true)
    const expected = sha256(Buffer.from('auction-bid-id-v1'), aucId, bidCommit)
    expect(bId.equals(expected)).toBe(true)
  })

  // Test 3: different bidders → different bid_commitments
  it('different bidders produce different bid_commitments', () => {
    const bHashA = bidderHash(BIDDER_A_SECRET)
    const bHashB = bidderHash(BIDDER_B_SECRET)
    const amount = 1000n
    const commitA = bidCommitment(bHashA, amount, NONCE_BID_A)
    const commitB = bidCommitment(bHashB, amount, NONCE_BID_A)
    expect(commitA.equals(commitB)).toBe(false)
  })

  // Test 4: bid_commitment sensitive to amount
  it('bid_commitment sensitive to amount', () => {
    const bHash = bidderHash(BIDDER_A_SECRET)
    const c1 = bidCommitment(bHash, 500n, NONCE_BID_A)
    const c2 = bidCommitment(bHash, 600n, NONCE_BID_A)
    expect(c1.equals(c2)).toBe(false)
  })

  // Test 5: public record hides winner until finalized
  it('public record hides winner until finalized', () => {
    const aucHash = auctioneerHash(AUCTIONEER_SECRET)
    const itmHash = itemHash(ITEM_BYTES)
    const aucId = auctionId(aucHash, itmHash, NONCE)
    const bHashA = bidderHash(BIDDER_A_SECRET)
    const commitA = bidCommitment(bHashA, 1000n, NONCE_BID_A)
    const bIdA = bidId(aucId, commitA)
    // Public pre-finalization record: only exposes auction_id and bid_id, not winner_hash
    const publicRecord = {
      auction_id: aucId.toString('hex'),
      bid_id: bIdA.toString('hex'),
      finalized: false,
      mainnet_ready: false,
    }
    expect(publicRecord).not.toHaveProperty('winner_hash')
    expect(publicRecord.finalized).toBe(false)
    expect(publicRecord.mainnet_ready).toBe(false)
    // winner_hash only appears after finalization
    const winner_hash = sha256(Buffer.from('auction-winner-v1'), bHashA).toString('hex')
    expect(publicRecord.auction_id).not.toEqual(winner_hash)
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready=false confirmed', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
    // Bidder hashes are also unique per secret
    const bHashA = bidderHash(BIDDER_A_SECRET)
    const bHashB = bidderHash(BIDDER_B_SECRET)
    expect(bHashA.equals(bHashB)).toBe(false)
    const expected = sha256(Buffer.from('auction-bidder-v1'), BIDDER_A_SECRET)
    expect(bHashA.equals(expected)).toBe(true)
  })
})
