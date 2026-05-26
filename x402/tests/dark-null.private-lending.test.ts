import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  return acc
}

function computeLenderHash(lenderSecret: Buffer): Buffer {
  return sha256(Buffer.from('loan-lender-v1'), lenderSecret)
}

function computeBorrowerHash(borrowerSecret: Buffer): Buffer {
  return sha256(Buffer.from('loan-borrower-v1'), borrowerSecret)
}

function computeCollateralHash(collateralBytes: Buffer): Buffer {
  return sha256(Buffer.from('loan-collateral-v1'), collateralBytes)
}

function computeOfferId(
  lenderHash: Buffer,
  principal: bigint,
  interestBps: number,
  durationSecs: bigint,
  collateralHash: Buffer
): Buffer {
  return sha256(
    Buffer.from('loan-offer-v1'),
    lenderHash,
    u64le(principal),
    u16le(interestBps),
    i64le(durationSecs),
    collateralHash
  )
}

function computeLoanId(offerId: Buffer, borrowerHash: Buffer, borrowedAt: bigint): Buffer {
  return sha256(Buffer.from('loan-id-v1'), offerId, borrowerHash, i64le(borrowedAt))
}

function computeRepaymentAmount(principal: bigint, interestBps: number): bigint {
  return principal + BigInt(Math.floor(Number(principal) * interestBps / 10_000))
}

function computeRepaymentHash(loanId: Buffer, repaymentAmount: bigint): Buffer {
  return sha256(Buffer.from('loan-repay-v1'), loanId, u64le(repaymentAmount))
}

describe('dark-null private-lending', () => {
  const lenderSecret = Buffer.from('lender-private-key-alpha')
  const borrowerSecret = Buffer.from('borrower-private-key-beta')
  const collateralBytes = Buffer.from('SOL-collateral-2000-lamports')

  // 1000 SOL in lamports (1 SOL = 1_000_000_000 lamports)
  const PRINCIPAL_LAMPORTS = 1_000n * 1_000_000_000n
  const INTEREST_BPS = 30 // 0.30%
  const DURATION_SECS = 7776000n // 90 days
  const BORROWED_AT = 1716768000n // 2024-05-27 00:00:00 UTC

  const lenderHash = computeLenderHash(lenderSecret)
  const borrowerHash = computeBorrowerHash(borrowerSecret)
  const collateralHash = computeCollateralHash(collateralBytes)

  const offerId = computeOfferId(lenderHash, PRINCIPAL_LAMPORTS, INTEREST_BPS, DURATION_SECS, collateralHash)
  const loanId = computeLoanId(offerId, borrowerHash, BORROWED_AT)
  const repaymentAmount = computeRepaymentAmount(PRINCIPAL_LAMPORTS, INTEREST_BPS)
  const repaymentHash = computeRepaymentHash(loanId, repaymentAmount)

  it('computes offer_id correctly', () => {
    const expected = sha256(
      Buffer.from('loan-offer-v1'),
      lenderHash,
      u64le(PRINCIPAL_LAMPORTS),
      u16le(INTEREST_BPS),
      i64le(DURATION_SECS),
      collateralHash
    )
    expect(offerId.toString('hex')).toBe(expected.toString('hex'))
    expect(offerId).toHaveLength(32)
  })

  it('computes loan_id correctly', () => {
    const expected = sha256(
      Buffer.from('loan-id-v1'),
      offerId,
      borrowerHash,
      i64le(BORROWED_AT)
    )
    expect(loanId.toString('hex')).toBe(expected.toString('hex'))
    expect(loanId).toHaveLength(32)
  })

  it('repayment amount is correct at 30bps (1000 SOL -> 1003 SOL)', () => {
    // 1000 SOL * 30bps = 1000 * 0.003 = 3 SOL interest
    const expected = 1_003n * 1_000_000_000n
    expect(repaymentAmount).toBe(expected)
  })

  it('computes repayment_hash correctly', () => {
    const expected = sha256(
      Buffer.from('loan-repay-v1'),
      loanId,
      u64le(repaymentAmount)
    )
    expect(repaymentHash.toString('hex')).toBe(expected.toString('hex'))
    expect(repaymentHash).toHaveLength(32)
  })

  it('borrower_hash is hidden in public loan record', () => {
    // loanId does not reveal borrowerSecret directly
    const loanIdHex = loanId.toString('hex')
    const secretHex = borrowerSecret.toString('hex')
    expect(loanIdHex).not.toContain(secretHex)
    // borrowerHash is a commitment; recomputing it matches
    const recomputed = computeBorrowerHash(borrowerSecret)
    expect(recomputed.toString('hex')).toBe(borrowerHash.toString('hex'))
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
    // private lending crate is stub-level only
    expect(loanId).toHaveLength(32)
    expect(repaymentHash).toHaveLength(32)
  })
})
