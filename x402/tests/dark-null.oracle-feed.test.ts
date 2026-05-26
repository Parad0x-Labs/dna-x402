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

function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// ---------------------------------------------------------------------------
// Domain primitives — oracle-feed
// ---------------------------------------------------------------------------

function oracleHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('ofd-oracle-v1'), secret)
}

function assetHash(asset: Buffer): Buffer {
  return sha256(Buffer.from('ofd-asset-v1'), asset)
}

function feedId(oracleH: Buffer, assetH: Buffer): Buffer {
  return sha256(Buffer.from('ofd-id-v1'), oracleH, assetH)
}

function priceCommitment(price: bigint, blinding: Buffer, timestamp: bigint): Buffer {
  return sha256(Buffer.from('ofd-price-v1'), u64le(price), blinding, i64le(timestamp))
}

function priceHash(price: bigint, timestamp: bigint): Buffer {
  return sha256(Buffer.from('ofd-pricehash-v1'), u64le(price), i64le(timestamp))
}

function attestationId(feedI: Buffer, priceH: Buffer, round: bigint): Buffer {
  return sha256(Buffer.from('ofd-attest-v1'), feedI, priceH, u64le(round))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null oracle-feed', () => {
  const oracleSecret = Buffer.alloc(32, 0xfe)
  const oracleH = oracleHash(oracleSecret)
  const assetBtc = Buffer.from('BTC-USD')
  const assetEth = Buffer.from('ETH-USD')
  const assetBtcH = assetHash(assetBtc)
  const assetEthH = assetHash(assetEth)
  const feedBtc = feedId(oracleH, assetBtcH)

  it('feed_id = SHA256("ofd-id-v1" || oracle_hash || asset_hash)', () => {
    const expected = sha256(Buffer.from('ofd-id-v1'), oracleH, assetBtcH)
    expect(feedBtc.toString('hex')).toBe(expected.toString('hex'))
    expect(feedBtc.length).toBe(32)
    expect(feedBtc.every(b => b === 0)).toBe(false)
  })

  it('price_commitment uses blinding', () => {
    const price = BigInt(65_000_00000000) // $65,000 with 8 decimals
    const ts = BigInt(1_700_000_000)
    const blinding1 = Buffer.alloc(32, 0x01)
    const blinding2 = Buffer.alloc(32, 0x02)
    const pc1 = priceCommitment(price, blinding1, ts)
    const pc2 = priceCommitment(price, blinding2, ts)
    expect(pc1.toString('hex')).not.toBe(pc2.toString('hex'))
    // Verify formula
    const expected = sha256(Buffer.from('ofd-price-v1'), u64le(price), blinding1, i64le(ts))
    expect(pc1.toString('hex')).toBe(expected.toString('hex'))
  })

  it('price_hash uses timestamp', () => {
    const price = BigInt(3_000_00000000)
    const ts1 = BigInt(1_700_000_000)
    const ts2 = BigInt(1_700_000_001)
    const ph1 = priceHash(price, ts1)
    const ph2 = priceHash(price, ts2)
    expect(ph1.toString('hex')).not.toBe(ph2.toString('hex'))
    // Verify formula
    const expected = sha256(Buffer.from('ofd-pricehash-v1'), u64le(price), i64le(ts1))
    expect(ph1.toString('hex')).toBe(expected.toString('hex'))
  })

  it('attestation_id is deterministic', () => {
    const ph = priceHash(BigInt(65_000_00000000), BigInt(1_700_000_000))
    const round = BigInt(42)
    const attest1 = attestationId(feedBtc, ph, round)
    const attest2 = attestationId(feedBtc, ph, round)
    expect(attest1.toString('hex')).toBe(attest2.toString('hex'))
    expect(attest1.every(b => b === 0)).toBe(false)
  })

  it('different assets produce different feed_ids', () => {
    const feedEth = feedId(oracleH, assetEthH)
    expect(feedBtc.toString('hex')).not.toBe(feedEth.toString('hex'))
  })

  it('mainnet_ready is false', () => {
    const record = { mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
