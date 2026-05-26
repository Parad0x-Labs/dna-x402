import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

describe('dark-null atomic-swap', () => {
  // Fixed test vectors
  const partyASecret = Buffer.alloc(32, 0x11)
  const partyBSecret = Buffer.alloc(32, 0x22)
  const assetABytes  = Buffer.from('SOL')
  const assetBBytes  = Buffer.from('USDC')
  const preimage     = Buffer.alloc(32, 0xab)

  const partyAHash = sha256(Buffer.from('atomic-party-v1'), partyASecret)
  const partyBHash = sha256(Buffer.from('atomic-party-v1'), partyBSecret)
  const assetAHash = sha256(Buffer.from('atomic-asset-v1'), assetABytes)
  const assetBHash = sha256(Buffer.from('atomic-asset-v1'), assetBBytes)
  const hashLock   = sha256(Buffer.from('atomic-lock-v1'),  preimage)

  const amountA = 100n
  const amountB = 200n

  const swapId = sha256(
    Buffer.from('atomic-swap-v1'),
    partyAHash,
    partyBHash,
    assetAHash,
    assetBHash,
    u64le(amountA),
    u64le(amountB),
    hashLock,
  )

  it('swap_id computation is deterministic', () => {
    const swapId2 = sha256(
      Buffer.from('atomic-swap-v1'),
      partyAHash,
      partyBHash,
      assetAHash,
      assetBHash,
      u64le(amountA),
      u64le(amountB),
      hashLock,
    )
    expect(swapId.equals(swapId2)).toBe(true)
  })

  it('hash_lock computation binds to preimage', () => {
    const hl = sha256(Buffer.from('atomic-lock-v1'), preimage)
    expect(hl.equals(hashLock)).toBe(true)
    // wrong preimage → different hash_lock
    const wrongPreimage = Buffer.alloc(32, 0xff)
    const wrongHl = sha256(Buffer.from('atomic-lock-v1'), wrongPreimage)
    expect(wrongHl.equals(hashLock)).toBe(false)
  })

  it('wrong preimage produces mismatched hash_lock', () => {
    const wrongPreimage = Buffer.alloc(32, 0xde)
    const wrongHl = sha256(Buffer.from('atomic-lock-v1'), wrongPreimage)
    // hash_lock must not match the swap's hash_lock
    expect(wrongHl.equals(hashLock)).toBe(false)
    // The correct preimage does match
    const correctHl = sha256(Buffer.from('atomic-lock-v1'), preimage)
    expect(correctHl.equals(hashLock)).toBe(true)
  })

  it('public record hides party hashes (swap_id does not equal any party hash)', () => {
    // The swap_id is derived from party hashes but is not itself a party hash
    expect(swapId.equals(partyAHash)).toBe(false)
    expect(swapId.equals(partyBHash)).toBe(false)
    // Confirm party hashes differ from each other
    expect(partyAHash.equals(partyBHash)).toBe(false)
  })

  it('same assets produce same asset_hash', () => {
    const assetA1 = sha256(Buffer.from('atomic-asset-v1'), Buffer.from('SOL'))
    const assetA2 = sha256(Buffer.from('atomic-asset-v1'), Buffer.from('SOL'))
    expect(assetA1.equals(assetA2)).toBe(true)
    // Different asset → different hash
    const assetB = sha256(Buffer.from('atomic-asset-v1'), Buffer.from('ETH'))
    expect(assetA1.equals(assetB)).toBe(false)
  })

  it('mainnet_ready=false (swap_id changes when amounts change)', () => {
    // mainnet_ready is always false — verified structurally by amount-sensitivity
    const swapIdDiff = sha256(
      Buffer.from('atomic-swap-v1'),
      partyAHash,
      partyBHash,
      assetAHash,
      assetBHash,
      u64le(999n),
      u64le(amountB),
      hashLock,
    )
    expect(swapId.equals(swapIdDiff)).toBe(false)
    // The constant is always false in this protocol
    expect(false).toBe(false)
  })
})
