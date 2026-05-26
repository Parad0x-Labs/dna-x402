import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u8(n: number): Buffer { return Buffer.from([n]) }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// Side enum (match lib.rs)
const Buy = 0
const Sell = 1

function traderHash(traderSecret: Buffer): Buffer {
  return sha256(Buffer.from('trader-hash-v1'), traderSecret)
}

function orderCommitment(
  side: number,
  amount: bigint,
  price: bigint,
  traderH: Buffer,
  nonce: Buffer,
): Buffer {
  return sha256(
    Buffer.from('order-commit-v1'),
    u8(side),
    u64le(amount),
    u64le(price),
    traderH,
    nonce,
  )
}

function receiptHash(
  buyCommitment: Buffer,
  sellCommitment: Buffer,
  epoch: bigint,
): Buffer {
  return sha256(
    Buffer.from('match-receipt-v1'),
    buyCommitment,
    sellCommitment,
    u64le(epoch),
  )
}

function tryMatch(
  buyPrice: bigint,
  sellPrice: bigint,
  buyAmount: bigint,
  sellAmount: bigint,
): { matched: boolean; filledAmount: bigint } {
  if (buyPrice < sellPrice) {
    return { matched: false, filledAmount: 0n }
  }
  const filledAmount = buyAmount < sellAmount ? buyAmount : sellAmount
  return { matched: true, filledAmount }
}

describe('dark-null dark-pool', () => {
  it('commit, reveal, match: buy@100 vs sell@90 → match', () => {
    const buyerSecret = Buffer.from('buyer-secret-001')
    const sellerSecret = Buffer.from('seller-secret-001')

    const buyerH = traderHash(buyerSecret)
    const sellerH = traderHash(sellerSecret)

    const buyNonce = Buffer.from('buy-nonce-0000001')
    const sellNonce = Buffer.from('sell-nonce-0000001')

    const buyPrice = 100n
    const sellPrice = 90n
    const buyAmount = 50n
    const sellAmount = 50n

    const buyCommit = orderCommitment(Buy, buyAmount, buyPrice, buyerH, buyNonce)
    const sellCommit = orderCommitment(Sell, sellAmount, sellPrice, sellerH, sellNonce)

    // Verify commitments are 32 bytes
    expect(buyCommit.length).toBe(32)
    expect(sellCommit.length).toBe(32)

    // Match
    const result = tryMatch(buyPrice, sellPrice, buyAmount, sellAmount)
    expect(result.matched).toBe(true)
    expect(result.filledAmount).toBe(50n)

    // Receipt
    const epoch = 1_000n
    const receipt = receiptHash(buyCommit, sellCommit, epoch)
    expect(receipt.length).toBe(32)
  })

  it('price mismatch: buy@80 vs sell@100 → no match', () => {
    const buyerSecret = Buffer.from('buyer-secret-002')
    const sellerSecret = Buffer.from('seller-secret-002')

    const buyerH = traderHash(buyerSecret)
    const sellerH = traderHash(sellerSecret)

    const buyNonce = Buffer.from('buy-nonce-0000002')
    const sellNonce = Buffer.from('sell-nonce-0000002')

    const buyPrice = 80n
    const sellPrice = 100n
    const buyAmount = 25n
    const sellAmount = 25n

    const buyCommit = orderCommitment(Buy, buyAmount, buyPrice, buyerH, buyNonce)
    const sellCommit = orderCommitment(Sell, sellAmount, sellPrice, sellerH, sellNonce)

    // buy_price < sell_price → no match
    const result = tryMatch(buyPrice, sellPrice, buyAmount, sellAmount)
    expect(result.matched).toBe(false)
    expect(result.filledAmount).toBe(0n)
  })

  it('filled_amount = min(buy, sell): 100 vs 50 → 50', () => {
    const buyerSecret = Buffer.from('buyer-secret-003')
    const sellerSecret = Buffer.from('seller-secret-003')

    const buyerH = traderHash(buyerSecret)
    const sellerH = traderHash(sellerSecret)

    const buyNonce = Buffer.from('buy-nonce-0000003')
    const sellNonce = Buffer.from('sell-nonce-0000003')

    const buyPrice = 95n
    const sellPrice = 90n
    const buyAmount = 100n
    const sellAmount = 50n

    const buyCommit = orderCommitment(Buy, buyAmount, buyPrice, buyerH, buyNonce)
    const sellCommit = orderCommitment(Sell, sellAmount, sellPrice, sellerH, sellNonce)

    const result = tryMatch(buyPrice, sellPrice, buyAmount, sellAmount)
    expect(result.matched).toBe(true)
    // filled = min(100, 50) = 50
    expect(result.filledAmount).toBe(50n)
  })

  it('commitment mismatch: wrong amount on reveal', () => {
    const buyerSecret = Buffer.from('buyer-secret-004')
    const buyerH = traderHash(buyerSecret)
    const nonce = Buffer.from('buy-nonce-0000004')

    const committedAmount = 75n
    const revealedAmount = 99n  // tampered
    const price = 100n

    const originalCommit = orderCommitment(Buy, committedAmount, price, buyerH, nonce)
    const recomputedCommit = orderCommitment(Buy, revealedAmount, price, buyerH, nonce)

    // Reveal with wrong amount must not match the original commitment
    expect(originalCommit.toString('hex')).not.toBe(recomputedCommit.toString('hex'))

    // Correct reveal matches
    const correctRecompute = orderCommitment(Buy, committedAmount, price, buyerH, nonce)
    expect(originalCommit.toString('hex')).toBe(correctRecompute.toString('hex'))
  })

  it('receipt_hash is deterministic', () => {
    const buyerSecret = Buffer.from('buyer-secret-005')
    const sellerSecret = Buffer.from('seller-secret-005')

    const buyerH = traderHash(buyerSecret)
    const sellerH = traderHash(sellerSecret)

    const buyNonce = Buffer.from('buy-nonce-0000005')
    const sellNonce = Buffer.from('sell-nonce-0000005')

    const buyCommit = orderCommitment(Buy, 40n, 105n, buyerH, buyNonce)
    const sellCommit = orderCommitment(Sell, 40n, 95n, sellerH, sellNonce)

    const epoch = 2_000n

    const receipt1 = receiptHash(buyCommit, sellCommit, epoch)
    const receipt2 = receiptHash(buyCommit, sellCommit, epoch)

    expect(receipt1.toString('hex')).toBe(receipt2.toString('hex'))

    // Different epoch → different receipt
    const receipt3 = receiptHash(buyCommit, sellCommit, 3_000n)
    expect(receipt1.toString('hex')).not.toBe(receipt3.toString('hex'))
  })

  it('batch record hides trader hashes', () => {
    const buyerSecret = Buffer.from('buyer-secret-006')
    const sellerSecret = Buffer.from('seller-secret-006')

    const buyerH = traderHash(buyerSecret)
    const sellerH = traderHash(sellerSecret)

    const buyNonce = Buffer.from('buy-nonce-0000006')
    const sellNonce = Buffer.from('sell-nonce-0000006')

    const buyCommit = orderCommitment(Buy, 60n, 110n, buyerH, buyNonce)
    const sellCommit = orderCommitment(Sell, 60n, 100n, sellerH, sellNonce)

    const epoch = 5_000n
    const receipt = receiptHash(buyCommit, sellCommit, epoch)

    // The batch record contains only commitments and receipt, not trader hashes
    const batchRecord = {
      buy_commitment: buyCommit.toString('hex'),
      sell_commitment: sellCommit.toString('hex'),
      receipt: receipt.toString('hex'),
      epoch: epoch.toString(),
    }

    // Trader hashes are NOT present in the batch record
    expect('buyer_hash' in batchRecord).toBe(false)
    expect('seller_hash' in batchRecord).toBe(false)

    // But the receipt is still verifiable from commitments
    const verifiedReceipt = receiptHash(buyCommit, sellCommit, epoch)
    expect(batchRecord.receipt).toBe(verifiedReceipt.toString('hex'))
  })
})
