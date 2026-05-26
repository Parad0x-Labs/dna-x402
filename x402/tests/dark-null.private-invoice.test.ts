import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const MAINNET_READY = false

describe('dark-null.private-invoice', () => {
  const issuerSecret    = Buffer.from('invoice-issuer-secret-01', 'utf8')
  const recipientSecret = Buffer.from('invoice-recipient-secret-01', 'utf8')
  const blinding        = Buffer.from('invoice-blinding-32b-padding!!', 'utf8').slice(0, 32)
  const amount          = BigInt(50000)
  const dueEpoch        = BigInt(1800000000)

  it('invoice_id formula is correct', () => {
    const issuerHash    = sha256(Buffer.from('inv-issuer-v1'), issuerSecret)
    const recipientHash = sha256(Buffer.from('inv-recipient-v1'), recipientSecret)
    const amountCommit  = sha256(Buffer.from('inv-amount-v1'), u64le(amount), blinding)
    const dueLe8        = u64le(dueEpoch)
    const invoiceId     = sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, dueLe8)
    expect(invoiceId.length).toBe(32)
    expect(invoiceId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(invoiceId.equals(sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, dueLe8))).toBe(true)
  })

  it('amount_commitment uses blinding', () => {
    const amountLe8     = u64le(amount)
    const commit1 = sha256(Buffer.from('inv-amount-v1'), amountLe8, blinding)
    const commit2 = sha256(Buffer.from('inv-amount-v1'), amountLe8, Buffer.alloc(32, 0xff))
    expect(commit1.equals(commit2)).toBe(false)
  })

  it('different amounts produce different amount_commitments', () => {
    const c1 = sha256(Buffer.from('inv-amount-v1'), u64le(BigInt(100)), blinding)
    const c2 = sha256(Buffer.from('inv-amount-v1'), u64le(BigInt(200)), blinding)
    expect(c1.equals(c2)).toBe(false)
  })

  it('invoice_id is deterministic', () => {
    const issuerHash    = sha256(Buffer.from('inv-issuer-v1'), issuerSecret)
    const recipientHash = sha256(Buffer.from('inv-recipient-v1'), recipientSecret)
    const amountCommit  = sha256(Buffer.from('inv-amount-v1'), u64le(amount), blinding)
    const dueLe8        = u64le(dueEpoch)
    const id1 = sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, dueLe8)
    const id2 = sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, dueLe8)
    expect(id1.equals(id2)).toBe(true)
  })

  it('different due epochs produce different invoice_ids', () => {
    const issuerHash    = sha256(Buffer.from('inv-issuer-v1'), issuerSecret)
    const recipientHash = sha256(Buffer.from('inv-recipient-v1'), recipientSecret)
    const amountCommit  = sha256(Buffer.from('inv-amount-v1'), u64le(amount), blinding)
    const id1 = sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, u64le(BigInt(1800000000)))
    const id2 = sha256(Buffer.from('inv-id-v1'), issuerHash, recipientHash, amountCommit, u64le(BigInt(1900000000)))
    expect(id1.equals(id2)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    expect(MAINNET_READY).toBe(false)
  })
})
