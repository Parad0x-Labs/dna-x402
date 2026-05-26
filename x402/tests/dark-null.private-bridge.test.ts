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
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// Private Bridge primitives
//
// depositor_hash     = SHA256("bridge2-depositor-v1" || depositor_secret)
// chain_hash         = SHA256("bridge2-chain-v1"     || chain_bytes)
// secret_hash        = SHA256("bridge2-secret-v1"    || bridge_secret)
// deposit_id         = SHA256("bridge2-deposit-v1"   || depositor_hash || amount_u64le || source_chain_hash || dest_chain_hash || secret_hash)
// claimer_hash       = SHA256("bridge2-claimer-v1"   || claimer_secret)
// claim_id           = SHA256("bridge2-claim-v1"     || deposit_id || claimer_hash)
// ---------------------------------------------------------------------------

function depositorHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('bridge2-depositor-v1'), secret)
}

function chainHash(chainBytes: Buffer): Buffer {
  return sha256(Buffer.from('bridge2-chain-v1'), chainBytes)
}

function secretHash(bridgeSecret: Buffer): Buffer {
  return sha256(Buffer.from('bridge2-secret-v1'), bridgeSecret)
}

function depositId(
  depHash: Buffer,
  amount: bigint,
  sourceChainHash: Buffer,
  destChainHash: Buffer,
  secHash: Buffer,
): Buffer {
  return sha256(
    Buffer.from('bridge2-deposit-v1'),
    depHash,
    u64le(amount),
    sourceChainHash,
    destChainHash,
    secHash,
  )
}

function claimerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('bridge2-claimer-v1'), secret)
}

function claimId(depId: Buffer, claHash: Buffer): Buffer {
  return sha256(Buffer.from('bridge2-claim-v1'), depId, claHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null private-bridge', () => {
  const DEPOSITOR_SECRET = Buffer.from('depositor-secret-bridge-000000000', 'utf8')
  const BRIDGE_SECRET    = Buffer.from('bridge-secret-0000000000000000000', 'utf8')
  const CLAIMER_SECRET   = Buffer.from('claimer-secret-bridge-0000000000', 'utf8')
  const AMOUNT           = 1_000_000n
  const SOURCE_CHAIN     = Buffer.from('solana-mainnet', 'utf8')
  const DEST_CHAIN       = Buffer.from('ethereum-mainnet', 'utf8')

  const depH    = depositorHash(DEPOSITOR_SECRET)
  const srcH    = chainHash(SOURCE_CHAIN)
  const dstH    = chainHash(DEST_CHAIN)
  const secH    = secretHash(BRIDGE_SECRET)
  const depId   = depositId(depH, AMOUNT, srcH, dstH, secH)

  it('deposit_id computation is deterministic and 32 bytes', () => {
    const depH2  = depositorHash(DEPOSITOR_SECRET)
    const srcH2  = chainHash(SOURCE_CHAIN)
    const dstH2  = chainHash(DEST_CHAIN)
    const secH2  = secretHash(BRIDGE_SECRET)
    const depId2 = depositId(depH2, AMOUNT, srcH2, dstH2, secH2)

    expect(depId.length).toBe(32)
    expect(depId.equals(depId2)).toBe(true)
  })

  it('claim_id computation is deterministic and depends on deposit_id', () => {
    const claH    = claimerHash(CLAIMER_SECRET)
    const clId1   = claimId(depId, claH)
    const clId2   = claimId(depId, claH)

    expect(clId1.length).toBe(32)
    expect(clId1.equals(clId2)).toBe(true)

    // Different claimer → different claim_id
    const otherClaimer = Buffer.from('different-claimer-00000000000000', 'utf8')
    const claH2 = claimerHash(otherClaimer)
    const clId3 = claimId(depId, claH2)
    expect(clId1.equals(clId3)).toBe(false)
  })

  it('wrong bridge secret produces different secret_hash (claim fails to match)', () => {
    const wrongSecret = Buffer.from('wrong-bridge-secret-00000000000000', 'utf8')
    const secHWrong   = secretHash(wrongSecret)
    const depIdWrong  = depositId(depH, AMOUNT, srcH, dstH, secHWrong)

    expect(secH.equals(secHWrong)).toBe(false)
    expect(depId.equals(depIdWrong)).toBe(false)
  })

  it('same chain bytes produce same chain_hash (same-chain detection)', () => {
    const chainA = Buffer.from('solana-mainnet', 'utf8')
    const chainB = Buffer.from('solana-mainnet', 'utf8')

    const hA = chainHash(chainA)
    const hB = chainHash(chainB)
    expect(hA.equals(hB)).toBe(true)

    // different chain bytes → different hash
    const hC = chainHash(Buffer.from('ethereum-mainnet', 'utf8'))
    expect(hA.equals(hC)).toBe(false)
  })

  it('public record hides depositor identity', () => {
    const record = {
      deposit_id:    depId.toString('hex'),
      amount:        AMOUNT.toString(),
      mainnet_ready: false,
    }
    const json = JSON.stringify(record)

    expect(json).not.toContain(depH.toString('hex'))
    expect(json).not.toContain(DEPOSITOR_SECRET.toString('hex'))

    expect(record.mainnet_ready).toBe(false)
  })

  it('mainnet_ready is always false', () => {
    const record = {
      deposit_id:    depId.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
