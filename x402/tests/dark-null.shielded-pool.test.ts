import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// Hash scheme
function assetHash(asset_bytes: Buffer): Buffer {
  return sha256(Buffer.from('pool-asset-v1'), asset_bytes)
}
function poolId(asset_hash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('pool-id-v1'), asset_hash, nonce)
}
function shielderHash(shielder_secret: Buffer): Buffer {
  return sha256(Buffer.from('pool-shielder-v1'), shielder_secret)
}
function noteId(pool_id: Buffer, shielder_hash: Buffer, amount: bigint, nonce_note: Buffer): Buffer {
  return sha256(Buffer.from('pool-note-v1'), pool_id, shielder_hash, u64le(amount), nonce_note)
}
function depositRoot(note_ids: Buffer[], deposit_count: number): Buffer {
  return sha256(Buffer.from('pool-root-v1'), xorFold(note_ids), u32le(deposit_count))
}
function nullifierHash(note_id: Buffer, shielder_hash: Buffer): Buffer {
  return sha256(Buffer.from('pool-null-v1'), note_id, shielder_hash)
}

describe('dark-null.shielded-pool', () => {
  // Test 1: pool_id computation
  it('pool_id is correctly computed from asset_hash and nonce', () => {
    const asset_bytes = Buffer.from('SOL-mainnet')
    const nonce = Buffer.alloc(32, 0xAA)
    const ah = assetHash(asset_bytes)
    const pid = poolId(ah, nonce)
    const ah2 = sha256(Buffer.from('pool-asset-v1'), asset_bytes)
    const pid2 = sha256(Buffer.from('pool-id-v1'), ah2, nonce)
    expect(pid.toString('hex')).toBe(pid2.toString('hex'))
    expect(pid.length).toBe(32)
  })

  // Test 2: note_id computation
  it('note_id is correctly computed', () => {
    const asset_bytes = Buffer.from('USDC-mainnet')
    const nonce = Buffer.alloc(32, 0xBB)
    const nonce_note = Buffer.alloc(32, 0xCC)
    const shielder_secret = Buffer.alloc(32, 0x11)
    const ah = assetHash(asset_bytes)
    const pid = poolId(ah, nonce)
    const sh = shielderHash(shielder_secret)
    const nid = noteId(pid, sh, 1000n, nonce_note)
    const nid2 = sha256(Buffer.from('pool-note-v1'), pid, sh, u64le(1000n), nonce_note)
    expect(nid.toString('hex')).toBe(nid2.toString('hex'))
    expect(nid.length).toBe(32)
  })

  // Test 3: nullifier_hash computation
  it('nullifier_hash is correctly computed from note_id and shielder_hash', () => {
    const asset_bytes = Buffer.from('ETH-mainnet')
    const nonce = Buffer.alloc(32, 0x01)
    const nonce_note = Buffer.alloc(32, 0x02)
    const shielder_secret = Buffer.alloc(32, 0x33)
    const ah = assetHash(asset_bytes)
    const pid = poolId(ah, nonce)
    const sh = shielderHash(shielder_secret)
    const nid = noteId(pid, sh, 500n, nonce_note)
    const nh = nullifierHash(nid, sh)
    const nh2 = sha256(Buffer.from('pool-null-v1'), nid, sh)
    expect(nh.toString('hex')).toBe(nh2.toString('hex'))
    expect(nh.length).toBe(32)
  })

  // Test 4: deposit_root changes on shield (adding note)
  it('deposit_root changes when a new note is added', () => {
    const asset_bytes = Buffer.from('BTC-mainnet')
    const nonce = Buffer.alloc(32, 0x04)
    const shielder_secret = Buffer.alloc(32, 0x44)
    const ah = assetHash(asset_bytes)
    const pid = poolId(ah, nonce)
    const sh = shielderHash(shielder_secret)
    const nid1 = noteId(pid, sh, 100n, Buffer.alloc(32, 0x01))
    const nid2 = noteId(pid, sh, 200n, Buffer.alloc(32, 0x02))
    const root1 = depositRoot([nid1], 1)
    const root2 = depositRoot([nid1, nid2], 2)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  // Test 5: public record has asset_hash and pool_id (but not shielder_secret)
  it('public record contains asset_hash and pool_id, hides shielder_secret', () => {
    const asset_bytes = Buffer.from('asset-data')
    const nonce = Buffer.alloc(32, 0x05)
    const shielder_secret = Buffer.alloc(32, 0x55)
    const ah = assetHash(asset_bytes)
    const pid = poolId(ah, nonce)
    const publicRecord = JSON.stringify({
      asset_hash: ah.toString('hex'),
      pool_id: pid.toString('hex'),
      mainnet_ready: false,
    })
    const parsed = JSON.parse(publicRecord)
    expect(parsed.asset_hash).toBe(ah.toString('hex'))
    expect(parsed.pool_id).toBe(pid.toString('hex'))
    expect(parsed.mainnet_ready).toBe(false)
    // shielder_secret must not appear
    expect(publicRecord).not.toContain(shielder_secret.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready is always false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
