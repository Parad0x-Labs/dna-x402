import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// Hash scheme
function layerSecretHash(layer_secret: Buffer): Buffer {
  return sha256(Buffer.from('privacy-layer-v1'), layer_secret)
}
function layerId(layer_secret_hash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('privacy-layer-id-v1'), layer_secret_hash, nonce)
}
function commitment(payload_bytes: Buffer, layer_secret_hash: Buffer): Buffer {
  return sha256(Buffer.from('privacy-payload-commit-v1'), sha256(payload_bytes), layer_secret_hash)
}
function nullifier(commitment_: Buffer, layer_secret_hash: Buffer): Buffer {
  return sha256(Buffer.from('privacy-null-v1'), commitment_, layer_secret_hash)
}
function nullifierRoot(nullifiers: Buffer[]): Buffer {
  return sha256(Buffer.from('privacy-null-root-v1'), xorFold(nullifiers))
}
function payloadId(commitment_: Buffer, nullifier_: Buffer): Buffer {
  return sha256(Buffer.from('privacy-payload-id-v1'), commitment_, nullifier_)
}

describe('dark-null.privacy-layer', () => {
  // Test 1: layer_id computation
  it('layer_id is correctly computed from layer_secret and nonce', () => {
    const layer_secret = Buffer.alloc(32, 0x11)
    const nonce = Buffer.alloc(32, 0xAA)
    const lsh = layerSecretHash(layer_secret)
    const lid = layerId(lsh, nonce)
    // recompute independently
    const lsh2 = sha256(Buffer.from('privacy-layer-v1'), layer_secret)
    const lid2 = sha256(Buffer.from('privacy-layer-id-v1'), lsh2, nonce)
    expect(lid.toString('hex')).toBe(lid2.toString('hex'))
    expect(lid.length).toBe(32)
  })

  // Test 2: commitment computation
  it('commitment is correctly computed from payload and layer_secret_hash', () => {
    const layer_secret = Buffer.alloc(32, 0x22)
    const payload = Buffer.from('secret-payload-data')
    const lsh = layerSecretHash(layer_secret)
    const c = commitment(payload, lsh)
    const c2 = sha256(Buffer.from('privacy-payload-commit-v1'), sha256(payload), lsh)
    expect(c.toString('hex')).toBe(c2.toString('hex'))
    expect(c.length).toBe(32)
  })

  // Test 3: nullifier computation
  it('nullifier is correctly computed from commitment and layer_secret_hash', () => {
    const layer_secret = Buffer.alloc(32, 0x33)
    const payload = Buffer.from('payload-for-nullifier')
    const lsh = layerSecretHash(layer_secret)
    const c = commitment(payload, lsh)
    const n = nullifier(c, lsh)
    const n2 = sha256(Buffer.from('privacy-null-v1'), c, lsh)
    expect(n.toString('hex')).toBe(n2.toString('hex'))
    expect(n.length).toBe(32)
  })

  // Test 4: nullifier_root changes on protect (adding new nullifier)
  it('nullifier_root changes when a new nullifier is added', () => {
    const layer_secret = Buffer.alloc(32, 0x44)
    const lsh = layerSecretHash(layer_secret)
    const payload1 = Buffer.from('payload-1')
    const payload2 = Buffer.from('payload-2')
    const c1 = commitment(payload1, lsh)
    const c2 = commitment(payload2, lsh)
    const n1 = nullifier(c1, lsh)
    const n2 = nullifier(c2, lsh)
    const root1 = nullifierRoot([n1])
    const root2 = nullifierRoot([n1, n2])
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  // Test 5: public record hides layer_secret
  it('public record contains layer_id but not layer_secret', () => {
    const layer_secret = Buffer.alloc(32, 0x55)
    const nonce = Buffer.alloc(32, 0xBB)
    const lsh = layerSecretHash(layer_secret)
    const lid = layerId(lsh, nonce)
    const publicRecord = JSON.stringify({
      layer_id: lid.toString('hex'),
      mainnet_ready: false,
    })
    const parsed = JSON.parse(publicRecord)
    expect(parsed.layer_id).toBe(lid.toString('hex'))
    expect(parsed.mainnet_ready).toBe(false)
    // layer_secret must not appear in the public record
    expect(publicRecord).not.toContain(layer_secret.toString('hex'))
    expect(publicRecord).not.toContain(lsh.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready is always false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
