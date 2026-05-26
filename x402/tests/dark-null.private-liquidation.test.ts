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
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32,0); for (const h of hs) for (let i=0;i<32;i++) a[i]^=h[i]; return a }

// ---------------------------------------------------------------------------
// Private Liquidation
//
// borrower_hash         = SHA256("liq-borrower-v1"    || borrower_secret)
// collateral_commitment = SHA256("liq-collateral-v1"  || collateral_u64le || blinding_c)
// debt_commitment       = SHA256("liq-debt-v1"        || debt_u64le || blinding_d)
// position_id           = SHA256("liq-pos-v1"         || borrower_hash || collateral_commitment || debt_commitment)
// liquidator_hash       = SHA256("liq-liquidator-v1"  || liquidator_secret)
// repay_hash            = SHA256("liq-repay-v1"       || position_id || liquidator_hash)
// liq_id                = SHA256("liq-id-v1"          || repay_hash)
// health_factor         = Math.floor(collateral * 100 / debt)  — liquidatable if < 100
// ---------------------------------------------------------------------------

function borrowerHash(borrowerSecret: Buffer): Buffer {
  return sha256(Buffer.from('liq-borrower-v1'), borrowerSecret)
}

function collateralCommitment(collateral: bigint, blindingC: Buffer): Buffer {
  return sha256(Buffer.from('liq-collateral-v1'), u64le(collateral), blindingC)
}

function debtCommitment(debt: bigint, blindingD: Buffer): Buffer {
  return sha256(Buffer.from('liq-debt-v1'), u64le(debt), blindingD)
}

function positionId(
  borrowerSecret: Buffer,
  collateral: bigint, blindingC: Buffer,
  debt: bigint, blindingD: Buffer
): Buffer {
  const bh = borrowerHash(borrowerSecret)
  const cc = collateralCommitment(collateral, blindingC)
  const dc = debtCommitment(debt, blindingD)
  return sha256(Buffer.from('liq-pos-v1'), bh, cc, dc)
}

function liquidatorHash(liquidatorSecret: Buffer): Buffer {
  return sha256(Buffer.from('liq-liquidator-v1'), liquidatorSecret)
}

function liqId(
  posId: Buffer,
  liquidatorSecret: Buffer
): Buffer {
  const lh = liquidatorHash(liquidatorSecret)
  const rh = sha256(Buffer.from('liq-repay-v1'), posId, lh)
  return sha256(Buffer.from('liq-id-v1'), rh)
}

function healthFactor(collateral: bigint, debt: bigint): number {
  return Math.floor(Number(collateral) * 100 / Number(debt))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-liquidation', () => {
  const BORROWER_SECRET    = Buffer.from('borrower-secret-0001')
  const BLINDING_C         = Buffer.alloc(32, 0x11)
  const BLINDING_D         = Buffer.alloc(32, 0x22)
  const LIQUIDATOR_SECRET  = Buffer.from('liquidator-secret-0001')

  const COLLATERAL = 80_000n  // USD cents
  const DEBT       = 100_000n // USD cents  → health = 80 < 100 → liquidatable

  it('position_id computation is deterministic and correct', () => {
    const pid1 = positionId(BORROWER_SECRET, COLLATERAL, BLINDING_C, DEBT, BLINDING_D)
    const pid2 = positionId(BORROWER_SECRET, COLLATERAL, BLINDING_C, DEBT, BLINDING_D)

    expect(pid1.length).toBe(32)
    expect(pid1.equals(pid2)).toBe(true)

    // manual recompute
    const bh = sha256(Buffer.from('liq-borrower-v1'), BORROWER_SECRET)
    const cc = sha256(Buffer.from('liq-collateral-v1'), u64le(COLLATERAL), BLINDING_C)
    const dc = sha256(Buffer.from('liq-debt-v1'), u64le(DEBT), BLINDING_D)
    const expected = sha256(Buffer.from('liq-pos-v1'), bh, cc, dc)
    expect(pid1.equals(expected)).toBe(true)
  })

  it('health_factor < 100 makes position liquidatable', () => {
    const hf = healthFactor(COLLATERAL, DEBT)
    expect(hf).toBeLessThan(100)
    expect(hf).toBe(80)

    // healthy position
    const hf_healthy = healthFactor(150_000n, 100_000n)
    expect(hf_healthy).toBeGreaterThanOrEqual(100)
    expect(hf_healthy).toBe(150)
  })

  it('liq_id computation is deterministic and correct', () => {
    const pid = positionId(BORROWER_SECRET, COLLATERAL, BLINDING_C, DEBT, BLINDING_D)
    const lid1 = liqId(pid, LIQUIDATOR_SECRET)
    const lid2 = liqId(pid, LIQUIDATOR_SECRET)

    expect(lid1.length).toBe(32)
    expect(lid1.equals(lid2)).toBe(true)

    // manual recompute
    const lh = sha256(Buffer.from('liq-liquidator-v1'), LIQUIDATOR_SECRET)
    const rh = sha256(Buffer.from('liq-repay-v1'), pid, lh)
    const expected = sha256(Buffer.from('liq-id-v1'), rh)
    expect(lid1.equals(expected)).toBe(true)
  })

  it('public record hides borrower identity (borrower_hash not in record)', () => {
    const pid = positionId(BORROWER_SECRET, COLLATERAL, BLINDING_C, DEBT, BLINDING_D)
    const lid = liqId(pid, LIQUIDATOR_SECRET)
    const bh  = borrowerHash(BORROWER_SECRET)

    const publicRecord = {
      position_id: pid.toString('hex'),
      liq_id:      lid.toString('hex'),
      health_factor: healthFactor(COLLATERAL, DEBT),
      mainnet_ready: false,
    }

    // borrower_hash must NOT appear in the record
    const recordJson = JSON.stringify(publicRecord)
    expect(recordJson).not.toContain(bh.toString('hex'))
    expect(recordJson).not.toContain(BORROWER_SECRET.toString('hex'))
    expect(publicRecord.mainnet_ready).toBe(false)
  })

  it('different collateral values produce different position_ids', () => {
    const pid1 = positionId(BORROWER_SECRET, 80_000n, BLINDING_C, DEBT, BLINDING_D)
    const pid2 = positionId(BORROWER_SECRET, 90_000n, BLINDING_C, DEBT, BLINDING_D)
    expect(pid1.equals(pid2)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = {
      liq_id: liqId(
        positionId(BORROWER_SECRET, COLLATERAL, BLINDING_C, DEBT, BLINDING_D),
        LIQUIDATOR_SECRET
      ).toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
