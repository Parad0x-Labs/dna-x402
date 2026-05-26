import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Crypto primitives (mirrors dark-flash-loan-guard/src/lib.rs)
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

/** little-endian u64 */
function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function hexEncode(buf: Buffer): string {
  return buf.toString('hex')
}

// ---------------------------------------------------------------------------
// Flash loan primitives (TypeScript mirror of the Rust public API)
// ---------------------------------------------------------------------------

interface FlashLoanBorrow {
  borrow_id: Buffer
  borrower_hash: Buffer
  amount: bigint
  fee_bps: number
  slot: bigint
}

interface FlashLoanRepayment {
  borrow_id: Buffer
  repaid_amount: bigint
  required_amount: bigint
  repayment_proof: Buffer
}

interface FlashLoanReceipt {
  borrow_id: Buffer
  receipt_hash: Buffer
  amount: bigint
  fee_paid: bigint
}

/** SHA256("borrower-hash-v1" || borrower_secret) */
function computeBorrowerHash(borrowerSecret: Buffer): Buffer {
  return sha256(Buffer.from('borrower-hash-v1'), borrowerSecret)
}

/** SHA256("flash-borrow-v1" || amount_le || borrower_hash || slot_le) */
function computeBorrowId(amount: bigint, borrowerHash: Buffer, slot: bigint): Buffer {
  return sha256(Buffer.from('flash-borrow-v1'), u64le(amount), borrowerHash, u64le(slot))
}

/** required = amount + floor(amount * fee_bps / 10_000) */
function computeRequired(amount: bigint, feeBps: number): bigint {
  return amount + (amount * BigInt(feeBps)) / 10_000n
}

/** SHA256("flash-repay-v1" || borrow_id || repaid_le) */
function computeRepaymentProof(borrowId: Buffer, repaidAmount: bigint): Buffer {
  return sha256(Buffer.from('flash-repay-v1'), borrowId, u64le(repaidAmount))
}

/** SHA256("flash-receipt-v1" || borrow_id || repayment_proof) */
function computeReceiptHash(borrowId: Buffer, repaymentProof: Buffer): Buffer {
  return sha256(Buffer.from('flash-receipt-v1'), borrowId, repaymentProof)
}

function createBorrow(
  borrowerSecret: Buffer,
  amount: bigint,
  feeBps: number,
  slot: bigint,
): FlashLoanBorrow {
  const borrowerHash = computeBorrowerHash(borrowerSecret)
  const borrowId = computeBorrowId(amount, borrowerHash, slot)
  return { borrow_id: borrowId, borrower_hash: borrowerHash, amount, fee_bps: feeBps, slot }
}

function repayLoan(
  borrow: FlashLoanBorrow,
  repaidAmount: bigint,
): { ok: FlashLoanRepayment } | { err: string } {
  const requiredAmount = computeRequired(borrow.amount, borrow.fee_bps)
  if (repaidAmount < requiredAmount) {
    return { err: `InsufficientRepayment: required=${requiredAmount}, provided=${repaidAmount}` }
  }
  const repaymentProof = computeRepaymentProof(borrow.borrow_id, repaidAmount)
  return {
    ok: {
      borrow_id: borrow.borrow_id,
      repaid_amount: repaidAmount,
      required_amount: requiredAmount,
      repayment_proof: repaymentProof,
    },
  }
}

function finalizeLoan(
  borrow: FlashLoanBorrow,
  repayment: FlashLoanRepayment,
): { ok: FlashLoanReceipt } | { err: string } {
  if (!borrow.borrow_id.equals(repayment.borrow_id)) {
    return { err: 'BorrowIdMismatch' }
  }
  const receiptHash = computeReceiptHash(borrow.borrow_id, repayment.repayment_proof)
  const feePaid = repayment.repaid_amount - borrow.amount
  return {
    ok: {
      borrow_id: borrow.borrow_id,
      receipt_hash: receiptHash,
      amount: borrow.amount,
      fee_paid: feePaid,
    },
  }
}

function loanPublicRecord(receipt: FlashLoanReceipt): Record<string, unknown> {
  return {
    borrow_id_hex: hexEncode(receipt.borrow_id),
    receipt_hash_hex: hexEncode(receipt.receipt_hash),
    fee_paid: receipt.fee_paid.toString(),
    // borrower_hash intentionally excluded
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function testSecret(): Buffer {
  const s = Buffer.alloc(32, 0)
  s[0] = 0xde
  s[1] = 0xad
  s[31] = 0xff
  return s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null flash loan guard', () => {
  it('happy path: borrow, repay, finalize (30bps, exact repayment)', () => {
    const secret = testSecret()
    const amount = 1_000_000n
    const feeBps = 30
    const slot = 42n

    const borrow = createBorrow(secret, amount, feeBps, slot)
    expect(borrow.borrow_id.length).toBe(32)
    expect(borrow.amount).toBe(amount)
    expect(borrow.fee_bps).toBe(feeBps)

    const required = computeRequired(amount, feeBps)
    const repayResult = repayLoan(borrow, required)
    expect('ok' in repayResult).toBe(true)

    const repayment = (repayResult as { ok: FlashLoanRepayment }).ok
    expect(repayment.required_amount).toBe(required)
    expect(repayment.repayment_proof.length).toBe(32)

    const finalResult = finalizeLoan(borrow, repayment)
    expect('ok' in finalResult).toBe(true)

    const receipt = (finalResult as { ok: FlashLoanReceipt }).ok
    expect(receipt.borrow_id.equals(borrow.borrow_id)).toBe(true)
    expect(receipt.amount).toBe(amount)
    expect(receipt.fee_paid).toBe(required - amount)
    expect(receipt.receipt_hash.length).toBe(32)
    // receipt_hash must be non-zero
    expect(receipt.receipt_hash.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('insufficient repayment rejected', () => {
    const secret = testSecret()
    const amount = 500_000n
    const feeBps = 30

    const borrow = createBorrow(secret, amount, feeBps, 1n)
    const required = computeRequired(amount, feeBps)
    const result = repayLoan(borrow, required - 1n)

    expect('err' in result).toBe(true)
    expect((result as { err: string }).err).toContain('InsufficientRepayment')
    expect((result as { err: string }).err).toContain(required.toString())
  })

  it('fee calculation at 30bps: 10_000 SOL × 30bps = 30 SOL fee', () => {
    const LAMPORTS_PER_SOL = 1_000_000_000n
    const amount = 10_000n * LAMPORTS_PER_SOL
    const feeBps = 30

    const expected_fee = 30n * LAMPORTS_PER_SOL // 30 SOL in lamports
    const actual_fee = (amount * BigInt(feeBps)) / 10_000n

    expect(actual_fee).toBe(expected_fee)

    const secret = testSecret()
    const borrow = createBorrow(secret, amount, feeBps, 7n)
    const required = computeRequired(amount, feeBps)
    const repayResult = repayLoan(borrow, required)
    expect('ok' in repayResult).toBe(true)

    const finalResult = finalizeLoan(borrow, (repayResult as { ok: FlashLoanRepayment }).ok)
    expect('ok' in finalResult).toBe(true)
    expect((finalResult as { ok: FlashLoanReceipt }).ok.fee_paid).toBe(expected_fee)
  })

  it('borrow_id is deterministic — same inputs always produce same borrow_id', () => {
    const secret = testSecret()
    const amount = 999_999n
    const feeBps = 50
    const slot = 100n

    const b1 = createBorrow(secret, amount, feeBps, slot)
    const b2 = createBorrow(secret, amount, feeBps, slot)
    const b3 = createBorrow(secret, amount, feeBps, slot)

    expect(b1.borrow_id.equals(b2.borrow_id)).toBe(true)
    expect(b1.borrow_id.equals(b3.borrow_id)).toBe(true)

    // Different slot → different borrow_id
    const bOther = createBorrow(secret, amount, feeBps, slot + 1n)
    expect(b1.borrow_id.equals(bOther.borrow_id)).toBe(false)
  })

  it('receipt_hash chains through repayment_proof — different repaid amount → different receipt_hash', () => {
    const secret = testSecret()
    const amount = 1_000_000n
    const feeBps = 30
    const borrow = createBorrow(secret, amount, feeBps, 1n)
    const required = computeRequired(amount, feeBps)

    // Two different repaid amounts (both >= required, so both valid)
    const repay1 = repayLoan(borrow, required)
    const repay2 = repayLoan(borrow, required + 1n)
    expect('ok' in repay1).toBe(true)
    expect('ok' in repay2).toBe(true)

    const r1 = (repay1 as { ok: FlashLoanRepayment }).ok
    const r2 = (repay2 as { ok: FlashLoanRepayment }).ok

    // Different repaid amount → different repayment_proof
    expect(r1.repayment_proof.equals(r2.repayment_proof)).toBe(false)

    // Different repayment_proof → different receipt_hash
    const final1 = (finalizeLoan(borrow, r1) as { ok: FlashLoanReceipt }).ok
    const final2 = (finalizeLoan(borrow, r2) as { ok: FlashLoanReceipt }).ok
    expect(final1.receipt_hash.equals(final2.receipt_hash)).toBe(false)
  })

  it('public record shape — has borrow_id_hex, receipt_hash_hex, fee_paid; no borrower_hash', () => {
    const secret = testSecret()
    const amount = 1_000_000n
    const feeBps = 30
    const borrow = createBorrow(secret, amount, feeBps, 99n)
    const required = computeRequired(amount, feeBps)
    const repayment = (repayLoan(borrow, required) as { ok: FlashLoanRepayment }).ok
    const receipt = (finalizeLoan(borrow, repayment) as { ok: FlashLoanReceipt }).ok

    const record = loanPublicRecord(receipt)
    const recordJson = JSON.stringify(record)

    // Required fields present
    expect(typeof record.borrow_id_hex).toBe('string')
    expect(typeof record.receipt_hash_hex).toBe('string')
    expect(record.fee_paid).toBeDefined()

    // borrow_id_hex is a 64-char hex string (32 bytes)
    expect((record.borrow_id_hex as string).length).toBe(64)
    expect((record.receipt_hash_hex as string).length).toBe(64)

    // borrower_hash must NOT appear in the record
    const borrowerHashHex = hexEncode(borrow.borrower_hash)
    expect(recordJson).not.toContain(borrowerHashHex)
    expect(Object.keys(record)).not.toContain('borrower_hash')
  })
})
