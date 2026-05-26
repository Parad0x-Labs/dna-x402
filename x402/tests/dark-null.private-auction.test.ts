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

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Private-auction primitives (mirrors crates/dark-private-auction)
//
// bidder_hash     = SHA256("bidder-hash-v1"    || bidder_secret)
// bid_commitment  = SHA256("bid-commit-v1"      || bidder_hash || amount_le[8] || nonce[32])
// result_hash     = SHA256("auction-result-v1"  || auction_id_le[8] || winner_bidder_hash || winning_amount_le[8])
// winner          = highest amount; tie → earliest committed_at_unix
// ---------------------------------------------------------------------------

const PFX_BIDDER  = Buffer.from('bidder-hash-v1')
const PFX_BID     = Buffer.from('bid-commit-v1')
const PFX_RESULT  = Buffer.from('auction-result-v1')

function bidderHash(secret: Buffer): Buffer {
  return sha256(PFX_BIDDER, secret)
}

function bidCommitment(bHash: Buffer, amount: bigint, nonce: Buffer): Buffer {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes')
  return sha256(PFX_BID, bHash, u64le(amount), nonce)
}

function resultHash(auctionId: bigint, winnerBidderHash: Buffer, winningAmount: bigint): Buffer {
  return sha256(PFX_RESULT, u64le(auctionId), winnerBidderHash, u64le(winningAmount))
}

// ---------------------------------------------------------------------------
// Auction state machine
// ---------------------------------------------------------------------------
interface SealedBid {
  bidderHashHex: string
  commitment: Buffer
  amount: bigint
  nonce: Buffer
  committedAtUnix: number
}

interface AuctionState {
  auctionId: bigint
  bids: SealedBid[]
}

function newAuction(auctionId: bigint): AuctionState {
  return { auctionId, bids: [] }
}

function placeBid(
  state: AuctionState,
  bidderSecret: Buffer,
  amount: bigint,
  nonce: Buffer,
  committedAtUnix: number,
): AuctionState {
  if (amount === 0n) throw new Error('zero bid rejected')
  const bHash = bidderHash(bidderSecret)
  const commitment = bidCommitment(bHash, amount, nonce)
  const bid: SealedBid = {
    bidderHashHex: bHash.toString('hex'),
    commitment,
    amount,
    nonce,
    committedAtUnix,
  }
  return { ...state, bids: [...state.bids, bid] }
}

function revealBid(
  state: AuctionState,
  bidderSecret: Buffer,
  amount: bigint,
  nonce: Buffer,
): SealedBid {
  const bHash    = bidderHash(bidderSecret)
  const expected = bidCommitment(bHash, amount, nonce)
  const found    = state.bids.find(b => b.commitment.equals(expected))
  if (!found) throw new Error('commitment mismatch')
  return found
}

interface AuctionResult {
  winnerBidderHashHex: string
  winningAmount: bigint
  resultHashBuf: Buffer
  publicRecord: object
}

function finalizeAuction(state: AuctionState): AuctionResult {
  if (state.bids.length === 0) throw new Error('no bids')

  // Winner = highest amount; tie → earliest committedAtUnix
  const winner = state.bids.reduce((best, bid) => {
    if (bid.amount > best.amount) return bid
    if (bid.amount === best.amount && bid.committedAtUnix < best.committedAtUnix) return bid
    return best
  })

  const winnerHash = Buffer.from(winner.bidderHashHex, 'hex')
  const rHash      = resultHash(state.auctionId, winnerHash, winner.winningAmount ?? winner.amount)

  const publicRecord = {
    auction_id:    state.auctionId.toString(),
    bid_count:     state.bids.length,
    result_hash:   rHash.toString('hex'),
    // winner identity hidden
    winner_hash:   null,
    winning_amount: null,
    mainnet_ready: false,
  }

  return {
    winnerBidderHashHex: winner.bidderHashHex,
    winningAmount:       winner.amount,
    resultHashBuf:       rHash,
    publicRecord,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-auction', () => {
  const AUCTION_ID = 7n
  const SECRET_A   = Buffer.from('bidder-alice-secret-0000000000000', 'utf8')
  const SECRET_B   = Buffer.from('bidder-bob-secret-00000000000000', 'utf8')
  const SECRET_C   = Buffer.from('bidder-carol-secret-0000000000000', 'utf8')
  const NONCE_A    = Buffer.alloc(32).fill(0xaa)
  const NONCE_B    = Buffer.alloc(32).fill(0xbb)
  const NONCE_C    = Buffer.alloc(32).fill(0xcc)

  it('3 bidders: highest amount wins', () => {
    let state = newAuction(AUCTION_ID)
    state = placeBid(state, SECRET_A, 100n, NONCE_A, 1000)
    state = placeBid(state, SECRET_B, 250n, NONCE_B, 1001)  // highest
    state = placeBid(state, SECRET_C, 200n, NONCE_C, 1002)

    const result = finalizeAuction(state)
    expect(result.winnerBidderHashHex).toBe(bidderHash(SECRET_B).toString('hex'))
    expect(result.winningAmount).toBe(250n)
  })

  it('tie goes to the earlier committed_at_unix timestamp', () => {
    let state = newAuction(AUCTION_ID)
    // Both bid 300 — A placed later, B placed earlier
    state = placeBid(state, SECRET_A, 300n, NONCE_A, 2000)
    state = placeBid(state, SECRET_B, 300n, NONCE_B, 1500)  // earlier → wins

    const result = finalizeAuction(state)
    expect(result.winnerBidderHashHex).toBe(bidderHash(SECRET_B).toString('hex'))
    expect(result.winningAmount).toBe(300n)
  })

  it('commitment mismatch is rejected on reveal', () => {
    let state = newAuction(AUCTION_ID)
    state = placeBid(state, SECRET_A, 100n, NONCE_A, 1000)

    // Wrong nonce
    expect(() => revealBid(state, SECRET_A, 100n, NONCE_B)).toThrow('commitment mismatch')
    // Wrong amount
    expect(() => revealBid(state, SECRET_A, 999n, NONCE_A)).toThrow('commitment mismatch')
  })

  it('zero bid is rejected', () => {
    const state = newAuction(AUCTION_ID)
    expect(() => placeBid(state, SECRET_A, 0n, NONCE_A, 1000)).toThrow('zero bid rejected')
  })

  it('result_hash is deterministic for the same inputs', () => {
    const wHash = bidderHash(SECRET_A)
    const h1    = resultHash(AUCTION_ID, wHash, 500n)
    const h2    = resultHash(AUCTION_ID, wHash, 500n)
    expect(h1.equals(h2)).toBe(true)

    // Different amount → different hash
    const h3 = resultHash(AUCTION_ID, wHash, 501n)
    expect(h1.equals(h3)).toBe(false)

    // Different auction_id → different hash
    const h4 = resultHash(99n, wHash, 500n)
    expect(h1.equals(h4)).toBe(false)
  })

  it('public record hides winner_hash and winning_amount, and mainnet_ready is false', () => {
    let state = newAuction(AUCTION_ID)
    state = placeBid(state, SECRET_A, 150n, NONCE_A, 1000)
    state = placeBid(state, SECRET_B, 175n, NONCE_B, 1001)

    const { publicRecord } = finalizeAuction(state)
    const rec = publicRecord as Record<string, unknown>

    expect(rec['winner_hash']).toBeNull()
    expect(rec['winning_amount']).toBeNull()
    expect(typeof rec['result_hash']).toBe('string')
    expect((rec['result_hash'] as string).length).toBe(64)
    expect(rec['mainnet_ready']).toBe(false)

    // Ensure actual bidder hashes are not leaking into the serialised record
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(bidderHash(SECRET_A).toString('hex'))
    expect(serialised).not.toContain(bidderHash(SECRET_B).toString('hex'))
  })
})
