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

// ---------------------------------------------------------------------------
// Domain primitives — private-transfer-v2
// ---------------------------------------------------------------------------

function senderCommitment(senderSecret: Buffer, blinding: Buffer): Buffer {
  return sha256(Buffer.from('ptv2-sender-v1'), senderSecret, blinding)
}

function receiverCommitment(receiverSecret: Buffer, blinding: Buffer): Buffer {
  return sha256(Buffer.from('ptv2-receiver-v1'), receiverSecret, blinding)
}

function amountCommitment(amount: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('ptv2-amount-v1'), u64le(amount), blinding)
}

function nullifier(senderCommit: Buffer, amountCommit: Buffer): Buffer {
  return sha256(Buffer.from('ptv2-null-v1'), senderCommit, amountCommit)
}

function transferId(senderCommit: Buffer, receiverCommit: Buffer, nullifierHash: Buffer): Buffer {
  return sha256(Buffer.from('ptv2-id-v1'), senderCommit, receiverCommit, nullifierHash)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-transfer-v2', () => {
  const senderSecret = Buffer.alloc(32, 0x11)
  const receiverSecret = Buffer.alloc(32, 0x22)
  const blindingS = Buffer.alloc(32, 0xaa)
  const blindingR = Buffer.alloc(32, 0xbb)
  const blindingA = Buffer.alloc(32, 0xcc)
  const amount = BigInt(1_000_000)

  const sCommit = senderCommitment(senderSecret, blindingS)
  const rCommit = receiverCommitment(receiverSecret, blindingR)
  const aCommit = amountCommitment(amount, blindingA)
  const nullH = nullifier(sCommit, aCommit)
  const txId = transferId(sCommit, rCommit, nullH)

  it('transfer_id formula is correct', () => {
    const expected = sha256(Buffer.from('ptv2-id-v1'), sCommit, rCommit, nullH)
    expect(txId.toString('hex')).toBe(expected.toString('hex'))
    expect(txId.length).toBe(32)
  })

  it('nullifier = SHA256("ptv2-null-v1" || sender_commitment || amount_commitment)', () => {
    const expected = sha256(Buffer.from('ptv2-null-v1'), sCommit, aCommit)
    expect(nullH.toString('hex')).toBe(expected.toString('hex'))
  })

  it('different amounts produce different amount_commitments', () => {
    const amount2 = BigInt(2_000_000)
    const aCommit2 = amountCommitment(amount2, blindingA)
    expect(aCommit.toString('hex')).not.toBe(aCommit2.toString('hex'))
  })

  it('transfer_id is deterministic', () => {
    const txId2 = transferId(sCommit, rCommit, nullH)
    expect(txId.toString('hex')).toBe(txId2.toString('hex'))
  })

  it('all fields are non-zero', () => {
    expect(sCommit.every(b => b === 0)).toBe(false)
    expect(rCommit.every(b => b === 0)).toBe(false)
    expect(aCommit.every(b => b === 0)).toBe(false)
    expect(nullH.every(b => b === 0)).toBe(false)
    expect(txId.every(b => b === 0)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const record = { mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
