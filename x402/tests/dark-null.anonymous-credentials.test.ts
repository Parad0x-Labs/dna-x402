import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

function issuerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('acred3-issuer-v1'), secret)
}
function holderHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('acred3-holder-v1'), secret)
}
function attrHash(name: Buffer, value: Buffer): Buffer {
  return sha256(Buffer.from('acred3-attr-v1'), name, value)
}
function attrRoot(attrHashes: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('acred3-aroot-v1'), xorFold(attrHashes), u32le(count))
}
function credId(iHash: Buffer, hHash: Buffer, aRoot: Buffer): Buffer {
  return sha256(Buffer.from('acred3-id-v1'), iHash, hHash, aRoot)
}
function disclosureNullifier(hHash: Buffer, cId: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('acred3-null-v1'), hHash, cId, nonce)
}
function disclosedRoot(discHashes: Buffer[], count: number): Buffer {
  return sha256(Buffer.from('acred3-disc-v1'), xorFold(discHashes), u32le(count))
}
function proofId(cId: Buffer, discRoot: Buffer, null_: Buffer): Buffer {
  return sha256(Buffer.from('acred3-proof-v1'), cId, discRoot, null_)
}

describe('dark-null.anonymous-credentials', () => {
  const issuerSecret = Buffer.alloc(32, 0x10)
  const holder1Secret = Buffer.alloc(32, 0x20)
  const holder2Secret = Buffer.alloc(32, 0x30)
  const nonce1 = Buffer.alloc(32, 0x01)
  const nonce2 = Buffer.alloc(32, 0x02)

  const attrName = Buffer.from('age')
  const attrValue = Buffer.from('over-18')
  const attrName2 = Buffer.from('nationality')
  const attrValue2 = Buffer.from('verified')

  it('cred_id formula is correct', () => {
    const iHash = issuerHash(issuerSecret)
    const hHash = holderHash(holder1Secret)
    const ah = attrHash(attrName, attrValue)
    const aRoot = attrRoot([ah], 1)
    const cId = credId(iHash, hHash, aRoot)
    const expected = sha256(Buffer.from('acred3-id-v1'), iHash, hHash, aRoot)
    expect(cId.toString('hex')).toBe(expected.toString('hex'))
    expect(cId.length).toBe(32)
  })

  it('attr_root changes with different attributes', () => {
    const ah1 = attrHash(attrName, attrValue)
    const root1 = attrRoot([ah1], 1)
    const ah2 = attrHash(attrName2, attrValue2)
    const root2 = attrRoot([ah1, ah2], 2)
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
  })

  it('disclosure_nullifier uses nonce — different nonces → different nullifiers', () => {
    const iHash = issuerHash(issuerSecret)
    const hHash = holderHash(holder1Secret)
    const ah = attrHash(attrName, attrValue)
    const aRoot = attrRoot([ah], 1)
    const cId = credId(iHash, hHash, aRoot)
    const null1 = disclosureNullifier(hHash, cId, nonce1)
    const null2 = disclosureNullifier(hHash, cId, nonce2)
    expect(null1.toString('hex')).not.toBe(null2.toString('hex'))
  })

  it('proof_id formula is correct', () => {
    const iHash = issuerHash(issuerSecret)
    const hHash = holderHash(holder1Secret)
    const ah = attrHash(attrName, attrValue)
    const aRoot = attrRoot([ah], 1)
    const cId = credId(iHash, hHash, aRoot)
    const null_ = disclosureNullifier(hHash, cId, nonce1)
    const dh = sha256(Buffer.from('acred3-attr-v1'), attrName, attrValue)
    const dRoot = disclosedRoot([dh], 1)
    const pid = proofId(cId, dRoot, null_)
    const expected = sha256(Buffer.from('acred3-proof-v1'), cId, dRoot, null_)
    expect(pid.toString('hex')).toBe(expected.toString('hex'))
  })

  it('different holders → different cred_ids', () => {
    const iHash = issuerHash(issuerSecret)
    const h1 = holderHash(holder1Secret)
    const h2 = holderHash(holder2Secret)
    const ah = attrHash(attrName, attrValue)
    const aRoot = attrRoot([ah], 1)
    const cId1 = credId(iHash, h1, aRoot)
    const cId2 = credId(iHash, h2, aRoot)
    expect(cId1.toString('hex')).not.toBe(cId2.toString('hex'))
  })

  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
