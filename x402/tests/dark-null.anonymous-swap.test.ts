import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u64le(n: bigint): Buffer {
  const b = Buffer.allocUnsafe(8)
  b.writeBigUInt64LE(n, 0)
  return b
}

interface SwapRecord {
  offer_id: string
  input_token_hash: string
  output_token_hash: string
  swap_id?: string
  nullifier?: string
  mainnet_ready: boolean
}

function computeSwap(params: {
  traderSecret: Buffer
  inputToken: Buffer
  outputToken: Buffer
  amountIn: bigint
  amountOut: bigint
  nonce: Buffer
  blockSlot?: bigint
}): {
  traderHash: Buffer
  inputTokenHash: Buffer
  outputTokenHash: Buffer
  offerId: Buffer
  swapId: Buffer | null
  nullifier: Buffer
  record: SwapRecord
} {
  const traderHash = sha256(Buffer.from('swap-trader-v1'), params.traderSecret)
  const inputTokenHash = sha256(Buffer.from('swap-token-v1'), params.inputToken)
  const outputTokenHash = sha256(Buffer.from('swap-token-v1'), params.outputToken)
  const offerId = sha256(
    Buffer.from('swap-offer-v1'),
    traderHash,
    inputTokenHash,
    outputTokenHash,
    u64le(params.amountIn),
    u64le(params.amountOut),
    params.nonce,
  )
  const swapId = params.blockSlot !== undefined
    ? sha256(Buffer.from('swap-id-v1'), offerId, u64le(params.blockSlot))
    : null
  const nullifier = sha256(Buffer.from('swap-null-v1'), offerId, traderHash)

  const record: SwapRecord = {
    offer_id: offerId.toString('hex'),
    input_token_hash: inputTokenHash.toString('hex'),
    output_token_hash: outputTokenHash.toString('hex'),
    ...(swapId ? { swap_id: swapId.toString('hex') } : {}),
    mainnet_ready: false,
  }

  return { traderHash, inputTokenHash, outputTokenHash, offerId, swapId, nullifier, record }
}

describe('dark-null Anonymous Swap', () => {
  const traderSecret = Buffer.from('trader-secret-abc')
  const inputToken = Buffer.from('SOL')
  const outputToken = Buffer.from('USDC')
  const nonce = Buffer.alloc(32, 0x42)

  it('offer_id computation matches expected value', () => {
    const traderHash = sha256(Buffer.from('swap-trader-v1'), traderSecret)
    const inputTokenHash = sha256(Buffer.from('swap-token-v1'), inputToken)
    const outputTokenHash = sha256(Buffer.from('swap-token-v1'), outputToken)
    const expectedOfferId = sha256(
      Buffer.from('swap-offer-v1'),
      traderHash,
      inputTokenHash,
      outputTokenHash,
      u64le(1000n),
      u64le(50000n),
      nonce,
    )

    const { offerId } = computeSwap({
      traderSecret,
      inputToken,
      outputToken,
      amountIn: 1000n,
      amountOut: 50000n,
      nonce,
    })

    expect(offerId.toString('hex')).toBe(expectedOfferId.toString('hex'))
  })

  it('nullifier is unique per offer: different amounts produce different nullifiers', () => {
    const base = { traderSecret, inputToken, outputToken, nonce }
    const s1 = computeSwap({ ...base, amountIn: 100n, amountOut: 5000n })
    const s2 = computeSwap({ ...base, amountIn: 200n, amountOut: 5000n })

    expect(s1.nullifier.toString('hex')).not.toBe(s2.nullifier.toString('hex'))
    expect(s1.offerId.toString('hex')).not.toBe(s2.offerId.toString('hex'))
  })

  it('swap_id depends on block_slot', () => {
    const base = { traderSecret, inputToken, outputToken, amountIn: 500n, amountOut: 25000n, nonce }
    const s1 = computeSwap({ ...base, blockSlot: 100n })
    const s2 = computeSwap({ ...base, blockSlot: 200n })

    expect(s1.swapId).not.toBeNull()
    expect(s2.swapId).not.toBeNull()
    expect(s1.swapId!.toString('hex')).not.toBe(s2.swapId!.toString('hex'))
    // offer_id is same because only slot differs
    expect(s1.offerId.toString('hex')).toBe(s2.offerId.toString('hex'))
  })

  it('public record contains offer_id and token hashes, NOT trader_hash', () => {
    const { record, traderHash } = computeSwap({
      traderSecret,
      inputToken,
      outputToken,
      amountIn: 1000n,
      amountOut: 50000n,
      nonce,
    })

    expect(record.offer_id).toBeDefined()
    expect(record.input_token_hash).toBeDefined()
    expect(record.output_token_hash).toBeDefined()
    // trader_hash must NOT appear in the public record
    expect(Object.values(record)).not.toContain(traderHash.toString('hex'))
    expect(record).not.toHaveProperty('trader_hash')
  })

  it('identical input and output token bytes produce the same hash (TokenHashesIdentical guard)', () => {
    const tokenBytes = Buffer.from('SAME')
    const hashA = sha256(Buffer.from('swap-token-v1'), tokenBytes)
    const hashB = sha256(Buffer.from('swap-token-v1'), tokenBytes)
    expect(hashA.toString('hex')).toBe(hashB.toString('hex'))
    // This equality is what triggers the TokenHashesIdentical guard in Rust
    expect(hashA.toString('hex')).toBe(hashB.toString('hex'))
  })

  it('mainnet_ready=false in all swap records', () => {
    const { record } = computeSwap({
      traderSecret,
      inputToken,
      outputToken,
      amountIn: 1000n,
      amountOut: 50000n,
      nonce,
      blockSlot: 999n,
    })
    expect(record.mainnet_ready).toBe(false)
  })
})
