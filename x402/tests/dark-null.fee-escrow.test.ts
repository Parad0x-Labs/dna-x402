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
// Fee-escrow primitives (mirrors crates/dark-fee-escrow)
//
// payer_hash   = SHA256("fee-payer-v1"   || payer_secret)
// service_hash = SHA256("fee-service-v1" || service_bytes)
// escrow_id    = SHA256("fee-escrow-v1"  || payer_hash || fee_amount_u64le || service_hash || nonce)
// ---------------------------------------------------------------------------

const PFX_PAYER   = Buffer.from('fee-payer-v1')
const PFX_SERVICE = Buffer.from('fee-service-v1')
const PFX_ESCROW  = Buffer.from('fee-escrow-v1')

function payerHash(secret: Buffer): Buffer {
  return sha256(PFX_PAYER, secret)
}

function serviceHash(serviceBytes: Buffer): Buffer {
  return sha256(PFX_SERVICE, serviceBytes)
}

function computeEscrowId(
  pHash: Buffer,
  feeAmount: bigint,
  sHash: Buffer,
  nonce: Buffer,
): Buffer {
  return sha256(PFX_ESCROW, pHash, u64le(feeAmount), sHash, nonce)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
type FeeStatus = 'Pending' | 'Released' | 'Refunded'

interface FeeEscrow {
  escrow_id: Buffer
  payer_hash: Buffer
  fee_amount: bigint
  service_hash: Buffer
  status: FeeStatus
  mainnet_ready: boolean
}

function createFeeEscrow(
  payerSecret: Buffer,
  feeAmount: bigint,
  serviceBytes: Buffer,
  nonce: Buffer,
): FeeEscrow {
  if (payerSecret.every(b => b === 0)) throw new Error('ZeroPayerSecret')
  if (feeAmount === 0n) throw new Error('ZeroFee')
  if (serviceBytes.length === 0) throw new Error('EmptyService')

  const pHash = payerHash(payerSecret)
  const sHash = serviceHash(serviceBytes)
  const escId = computeEscrowId(pHash, feeAmount, sHash, nonce)

  return {
    escrow_id: escId,
    payer_hash: pHash,
    fee_amount: feeAmount,
    service_hash: sHash,
    status: 'Pending',
    mainnet_ready: false,
  }
}

function releaseFee(escrow: FeeEscrow): FeeEscrow {
  if (escrow.status !== 'Pending') throw new Error('AlreadySettled')
  return { ...escrow, status: 'Released' }
}

function refundFee(escrow: FeeEscrow): FeeEscrow {
  if (escrow.status !== 'Pending') throw new Error('AlreadySettled')
  return { ...escrow, status: 'Refunded' }
}

function escrowPublicRecord(escrow: FeeEscrow): object {
  return {
    escrow_id: escrow.escrow_id.toString('hex'),
    fee_amount: escrow.fee_amount.toString(),
    service_hash: escrow.service_hash.toString('hex'),
    status: escrow.status,
    mainnet_ready: escrow.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null fee-escrow', () => {
  const PAYER_SECRET   = Buffer.from('payer-secret-000000000000000000', 'utf8')
  const SERVICE        = Buffer.from('agent-service')
  const FEE_AMOUNT     = 500n
  const NONCE          = Buffer.alloc(32).fill(0x01)

  it('escrow_id computation is deterministic', () => {
    const e1 = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    const e2 = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    expect(e1.escrow_id.equals(e2.escrow_id)).toBe(true)

    // Manual recompute
    const pHash  = payerHash(PAYER_SECRET)
    const sHash  = serviceHash(SERVICE)
    const manual = computeEscrowId(pHash, FEE_AMOUNT, sHash, NONCE)
    expect(e1.escrow_id.equals(manual)).toBe(true)
  })

  it('release sets status to "Released"', () => {
    const escrow   = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    expect(escrow.status).toBe('Pending')
    const released = releaseFee(escrow)
    expect(released.status).toBe('Released')
    // escrow_id unchanged
    expect(released.escrow_id.equals(escrow.escrow_id)).toBe(true)
  })

  it('refund sets status to "Refunded"', () => {
    const escrow   = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    const refunded = refundFee(escrow)
    expect(refunded.status).toBe('Refunded')
    expect(refunded.escrow_id.equals(escrow.escrow_id)).toBe(true)
  })

  it('public record hides payer_hash', () => {
    const escrow = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    const rec    = escrowPublicRecord(escrow) as Record<string, unknown>

    expect(typeof rec['escrow_id']).toBe('string')
    expect(rec['fee_amount']).toBe(FEE_AMOUNT.toString())
    expect(rec['mainnet_ready']).toBe(false)

    expect(Object.keys(rec)).not.toContain('payer_hash')
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(escrow.payer_hash.toString('hex'))
  })

  it('different fees → different escrow_ids', () => {
    const e1 = createFeeEscrow(PAYER_SECRET, 100n,   SERVICE, NONCE)
    const e2 = createFeeEscrow(PAYER_SECRET, 1_000n, SERVICE, NONCE)
    expect(e1.escrow_id.equals(e2.escrow_id)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const escrow = createFeeEscrow(PAYER_SECRET, FEE_AMOUNT, SERVICE, NONCE)
    expect(escrow.mainnet_ready).toBe(false)
    const rec = escrowPublicRecord(escrow) as Record<string, unknown>
    expect(rec['mainnet_ready']).toBe(false)
  })
})
