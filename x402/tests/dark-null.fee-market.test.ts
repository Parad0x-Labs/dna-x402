import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u8(n: number): Buffer { return Buffer.from([n]) }
function xor(a: Buffer, b: Buffer): Buffer { return Buffer.from(a.map((byte, i) => byte ^ b[i])) }

// ---------------------------------------------------------------------------
// Fee-market primitives (mirrors crates/dark-fee-market/src/lib.rs)
//
// bidder_hash = SHA256("fee-bidder-v1" || bidder_secret)
// quote_id    = SHA256("fee-quote-v1"  || bidder_hash || fee_le[8] || slot_le[8])
// winner      = highest fee_lamports quote
// ---------------------------------------------------------------------------

function bidder_hash(bidder_secret: Buffer): Buffer {
  if (bidder_secret.equals(Buffer.alloc(bidder_secret.length, 0))) {
    throw new Error('ZeroBidderSecret')
  }
  return sha256(Buffer.from('fee-bidder-v1'), bidder_secret)
}

function quote_id(bHash: Buffer, fee_lamports: bigint, slot: bigint): Buffer {
  if (fee_lamports === 0n) throw new Error('ZeroFee')
  return sha256(Buffer.from('fee-quote-v1'), bHash, u64le(fee_lamports), u64le(slot))
}

interface FeeQuote {
  quote_id:     Buffer
  bidder_hash:  Buffer
  fee_lamports: bigint
  slot:         bigint
}

interface FeeMarket {
  slot:     bigint
  quotes:   FeeQuote[]
  settled:  boolean
  winner:   FeeQuote | null
}

function create_market(slot: bigint): FeeMarket {
  return { slot, quotes: [], settled: false, winner: null }
}

function submit_quote(
  market: FeeMarket,
  bidder_secret: Buffer,
  fee_lamports: bigint,
): FeeQuote {
  if (market.settled) throw new Error('AlreadySettled')
  const bHash = bidder_hash(bidder_secret)
  const qid   = quote_id(bHash, fee_lamports, market.slot)
  const q: FeeQuote = { quote_id: qid, bidder_hash: bHash, fee_lamports, slot: market.slot }
  market.quotes.push(q)
  return q
}

function settle(market: FeeMarket): FeeQuote {
  if (market.settled) throw new Error('AlreadySettled')
  if (market.quotes.length === 0) throw new Error('NoQuotes')
  market.settled = true
  market.winner  = market.quotes.reduce((best, q) =>
    q.fee_lamports > best.fee_lamports ? q : best
  )
  return market.winner
}

function public_record(market: FeeMarket): object {
  return {
    slot:         market.slot.toString(),
    quote_count:  market.quotes.length,
    settled:      market.settled,
    winning_fee:  market.winner ? market.winner.fee_lamports.toString() : null,
    // bidder hashes hidden
    bidder_hashes: null,
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null fee-market', () => {
  const SECRET_A = Buffer.alloc(32).fill(0xa1)
  const SECRET_B = Buffer.alloc(32).fill(0xb2)
  const SECRET_C = Buffer.alloc(32).fill(0xc3)
  const SLOT     = 999n

  it('3 quotes: highest fee wins', () => {
    const market = create_market(SLOT)
    submit_quote(market, SECRET_A, 1_000n)
    submit_quote(market, SECRET_B, 5_000n)
    submit_quote(market, SECRET_C, 3_000n)

    const winner = settle(market)
    expect(winner.fee_lamports).toBe(5_000n)
    expect(market.settled).toBe(true)
  })

  it('zero fee rejected', () => {
    const market = create_market(SLOT)
    expect(() => submit_quote(market, SECRET_A, 0n)).toThrow('ZeroFee')
  })

  it('bidder secret zero rejected', () => {
    const market = create_market(SLOT)
    const zeroSecret = Buffer.alloc(32, 0)
    expect(() => submit_quote(market, zeroSecret, 1_000n)).toThrow('ZeroBidderSecret')
  })

  it('already settled rejected on second settle call', () => {
    const market = create_market(SLOT)
    submit_quote(market, SECRET_A, 1_000n)
    settle(market)
    expect(() => settle(market)).toThrow('AlreadySettled')
    // Also rejected on further quote submissions after settlement
    expect(() => submit_quote(market, SECRET_B, 2_000n)).toThrow('AlreadySettled')
  })

  it('public record has slot, quote_count, settled, winning_fee; no bidder hashes', () => {
    const market = create_market(SLOT)
    submit_quote(market, SECRET_A, 2_000n)
    submit_quote(market, SECRET_B, 4_000n)
    settle(market)

    const rec = public_record(market) as Record<string, unknown>
    expect(rec['slot']).toBe(SLOT.toString())
    expect(rec['quote_count']).toBe(2)
    expect(rec['settled']).toBe(true)
    expect(rec['winning_fee']).toBe('4000')
    expect(rec['bidder_hashes']).toBeNull()
    expect(rec['mainnet_ready']).toBe(false)

    // Ensure actual bidder hash bytes do not appear in serialised record
    const bHash = bidder_hash(SECRET_A).toString('hex')
    expect(JSON.stringify(rec)).not.toContain(bHash)
  })

  it('no quotes → settle throws NoQuotes', () => {
    const market = create_market(SLOT)
    expect(() => settle(market)).toThrow('NoQuotes')
  })
})
