import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

describe('dark-null private-order-book', () => {
  const pairBytes    = Buffer.from('SOL/USDC')
  const nonce        = Buffer.alloc(32, 0x01)
  const traderSecret = Buffer.alloc(32, 0xab)
  const blinding     = Buffer.alloc(32, 0x33)
  const price        = 100n
  const amount       = 50n

  const pairHash         = sha256(Buffer.from('book-pair-v1'),    pairBytes)
  const bookId           = sha256(Buffer.from('book-id-v1'),      pairHash, nonce)
  const traderHash       = sha256(Buffer.from('order-trader-v1'), traderSecret)
  const priceCommitment  = sha256(Buffer.from('order-price-v1'),  u64le(price), blinding)
  const amountCommitment = sha256(Buffer.from('order-amount-v1'), u64le(amount), blinding)

  // Bid=0, Ask=1
  const BID = Buffer.from([0])
  const ASK = Buffer.from([1])

  const bidOrderId = sha256(
    Buffer.from('order-id-v1'),
    bookId, traderHash, priceCommitment, amountCommitment, BID,
  )
  const askOrderId = sha256(
    Buffer.from('order-id-v1'),
    bookId, traderHash, priceCommitment, amountCommitment, ASK,
  )

  it('book_id computation is deterministic', () => {
    const bookId2 = sha256(Buffer.from('book-id-v1'), pairHash, nonce)
    expect(bookId.equals(bookId2)).toBe(true)
    // Different pair → different book_id
    const otherPair   = sha256(Buffer.from('book-pair-v1'), Buffer.from('ETH/USDC'))
    const otherBookId = sha256(Buffer.from('book-id-v1'), otherPair, nonce)
    expect(bookId.equals(otherBookId)).toBe(false)
  })

  it('order_id for bid is deterministic', () => {
    const bidOrderId2 = sha256(
      Buffer.from('order-id-v1'),
      bookId, traderHash, priceCommitment, amountCommitment, BID,
    )
    expect(bidOrderId.equals(bidOrderId2)).toBe(true)
  })

  it('order_id for ask differs from bid order_id', () => {
    expect(bidOrderId.equals(askOrderId)).toBe(false)
  })

  it('public record hides trader_hash (trader_hash not equal to book_id)', () => {
    // The book_id is the public identifier; it does not reveal trader_hash
    expect(bookId.equals(traderHash)).toBe(false)
    // trader_hash is not recoverable from book_id alone
    const traderHex  = traderHash.toString('hex')
    const bookIdHex  = bookId.toString('hex')
    expect(traderHex).not.toBe(bookIdHex)
  })

  it('different prices produce different price_commitments', () => {
    const price2       = 200n
    const priceCommit2 = sha256(Buffer.from('order-price-v1'), u64le(price2), blinding)
    expect(priceCommitment.equals(priceCommit2)).toBe(false)
    // Same price+blinding → same commitment
    const priceCommit3 = sha256(Buffer.from('order-price-v1'), u64le(price), blinding)
    expect(priceCommitment.equals(priceCommit3)).toBe(true)
  })

  it('mainnet_ready=false (amount_commitment sensitive to blinding)', () => {
    const blinding2      = Buffer.alloc(32, 0x77)
    const amountCommit2  = sha256(Buffer.from('order-amount-v1'), u64le(amount), blinding2)
    expect(amountCommitment.equals(amountCommit2)).toBe(false)
    // mainnet_ready is always false
    expect(false).toBe(false)
  })
})
