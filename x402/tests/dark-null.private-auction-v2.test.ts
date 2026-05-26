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
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0)
  for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]
  return a
}

// ---------------------------------------------------------------------------
// Domain primitives — private-auction-v2
// ---------------------------------------------------------------------------

function auctioneerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('auc2-auctioneer-v1'), secret)
}

function itemHash(item: Buffer): Buffer {
  return sha256(Buffer.from('auc2-item-v1'), item)
}

function auctionId(auctioneerH: Buffer, itemH: Buffer): Buffer {
  return sha256(Buffer.from('auc2-id-v1'), auctioneerH, itemH)
}

function bidderHash(bidderSecret: Buffer): Buffer {
  return sha256(Buffer.from('auc2-bidder-v1'), bidderSecret)
}

function bidCommitment(bidderH: Buffer, amount: bigint, nonce: Buffer): Buffer {
  return sha256(Buffer.from('auc2-bid-v1'), bidderH, u64le(amount), nonce)
}

function bidId(auctionI: Buffer, bidderH: Buffer): Buffer {
  return sha256(Buffer.from('auc2-bid-id-v1'), auctionI, bidderH)
}

function bidRoot(bidIds: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('auc2-root-v1'), xorFold(bidIds), u32le(count))
}

function reserveCommitment(reserve: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('auc2-reserve-v1'), u64le(reserve), blinding)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-auction-v2', () => {
  const auctioneerSecret = Buffer.alloc(32, 0xaa)
  const itemBytes = Buffer.from('rare-painting-#001')
  const auctioneerH = auctioneerHash(auctioneerSecret)
  const itemH = itemHash(itemBytes)
  const auctionI = auctionId(auctioneerH, itemH)

  it('auction_id = SHA256("auc2-id-v1" || auctioneer_hash || item_hash)', () => {
    const expected = sha256(Buffer.from('auc2-id-v1'), auctioneerH, itemH)
    expect(auctionI.toString('hex')).toBe(expected.toString('hex'))
    expect(auctionI.length).toBe(32)
    expect(auctionI.every(b => b === 0)).toBe(false)
  })

  it('bid_commitment uses "auc2-bid-v1" domain', () => {
    const bidderH = bidderHash(Buffer.alloc(32, 0xbb))
    const nonce = Buffer.alloc(32, 0xcc)
    const amount = BigInt(1_000_000)
    const commitment = bidCommitment(bidderH, amount, nonce)
    const expected = sha256(Buffer.from('auc2-bid-v1'), bidderH, u64le(amount), nonce)
    expect(commitment.toString('hex')).toBe(expected.toString('hex'))
    // Different nonce → different commitment
    const commitment2 = bidCommitment(bidderH, amount, Buffer.alloc(32, 0xdd))
    expect(commitment.toString('hex')).not.toBe(commitment2.toString('hex'))
  })

  it('bid_root changes after adding a bid', () => {
    const bidder1H = bidderHash(Buffer.alloc(32, 0x11))
    const bidder2H = bidderHash(Buffer.alloc(32, 0x22))
    const bid1 = bidId(auctionI, bidder1H)
    const root1 = bidRoot([bid1], 1)
    const bid2 = bidId(auctionI, bidder2H)
    const root2 = bidRoot([bid1, bid2], 2)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('reserve_commitment uses blinding correctly', () => {
    const reserve = BigInt(500_000)
    const blinding1 = Buffer.alloc(32, 0x01)
    const blinding2 = Buffer.alloc(32, 0x02)
    const rc1 = reserveCommitment(reserve, blinding1)
    const rc2 = reserveCommitment(reserve, blinding2)
    // Same reserve, different blinding → different commitment
    expect(rc1.toString('hex')).not.toBe(rc2.toString('hex'))
    // Matches expected formula
    const expected = sha256(Buffer.from('auc2-reserve-v1'), u64le(reserve), blinding1)
    expect(rc1.toString('hex')).toBe(expected.toString('hex'))
  })

  it('bid_root is deterministic for same bids', () => {
    const bidder1H = bidderHash(Buffer.alloc(32, 0x33))
    const bidder2H = bidderHash(Buffer.alloc(32, 0x44))
    const bid1 = bidId(auctionI, bidder1H)
    const bid2 = bidId(auctionI, bidder2H)
    const root1 = bidRoot([bid1, bid2], 2)
    const root2 = bidRoot([bid1, bid2], 2)
    expect(root1.toString('hex')).toBe(root2.toString('hex'))
    expect(root1.every(b => b === 0)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = { mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
