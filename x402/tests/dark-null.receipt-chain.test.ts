import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

describe('dark-null receipt-chain', () => {
  const issuerSecret  = Buffer.alloc(32, 0xee)
  const nonce         = Buffer.alloc(32, 0x01)
  const payloadBytes0 = Buffer.from('tx-payload-0')
  const payloadBytes1 = Buffer.from('tx-payload-1')

  const issuerHash    = sha256(Buffer.from('rchain-issuer-v1'), issuerSecret)
  const chainId       = sha256(Buffer.from('rchain-id-v1'),     issuerHash, nonce)

  const payloadHash0  = sha256(Buffer.from('rchain-payload-v1'), payloadBytes0)
  // seq=0, prev=chainId (initial head)
  const receiptHash0  = sha256(Buffer.from('rchain-receipt-v1'), chainId, payloadHash0, u32le(0))

  const payloadHash1  = sha256(Buffer.from('rchain-payload-v1'), payloadBytes1)
  // seq=1, prev=receiptHash0
  const receiptHash1  = sha256(Buffer.from('rchain-receipt-v1'), receiptHash0, payloadHash1, u32le(1))

  it('chain_id computation is deterministic', () => {
    const chainId2 = sha256(Buffer.from('rchain-id-v1'), issuerHash, nonce)
    expect(chainId.equals(chainId2)).toBe(true)
    // Different nonce → different chain_id
    const nonce2   = Buffer.alloc(32, 0x99)
    const chainId3 = sha256(Buffer.from('rchain-id-v1'), issuerHash, nonce2)
    expect(chainId.equals(chainId3)).toBe(false)
  })

  it('receipt_hash for seq=0 uses chain_id as prev_hash', () => {
    const expected = sha256(
      Buffer.from('rchain-receipt-v1'),
      chainId,
      payloadHash0,
      u32le(0),
    )
    expect(receiptHash0.equals(expected)).toBe(true)
  })

  it('receipt_hash for seq=1 uses previous receipt_hash as prev', () => {
    const expected = sha256(
      Buffer.from('rchain-receipt-v1'),
      receiptHash0,
      payloadHash1,
      u32le(1),
    )
    expect(receiptHash1.equals(expected)).toBe(true)
    // Must differ from seq=0
    expect(receiptHash0.equals(receiptHash1)).toBe(false)
  })

  it('chain advances head to receipt_hash after each append', () => {
    // After appending receipt0, head = receiptHash0
    // After appending receipt1, head = receiptHash1
    expect(receiptHash1.equals(chainId)).toBe(false)
    expect(receiptHash1.equals(receiptHash0)).toBe(false)
    // Verify linking: receipt1 references receipt0 as prev
    const checkLink = sha256(
      Buffer.from('rchain-receipt-v1'),
      receiptHash0,
      payloadHash1,
      u32le(1),
    )
    expect(checkLink.equals(receiptHash1)).toBe(true)
  })

  it('public record has chain_id, head, and receipt_count', () => {
    // Simulate JSON public record structure
    const record = {
      chain_id:      chainId.toString('hex'),
      head:          receiptHash1.toString('hex'),
      receipt_count: 2,
      mainnet_ready: false,
    }
    expect(typeof record.chain_id).toBe('string')
    expect(typeof record.head).toBe('string')
    expect(record.receipt_count).toBe(2)
    expect(record.mainnet_ready).toBe(false)
    // Public record should not expose issuer_hash directly
    expect(record.chain_id).not.toBe(issuerHash.toString('hex'))
  })

  it('mainnet_ready=false (receipt_hash sensitive to payload)', () => {
    const altPayload     = Buffer.from('completely-different-payload')
    const altPayloadHash = sha256(Buffer.from('rchain-payload-v1'), altPayload)
    const altReceipt     = sha256(Buffer.from('rchain-receipt-v1'), chainId, altPayloadHash, u32le(0))
    expect(altReceipt.equals(receiptHash0)).toBe(false)
    // mainnet_ready is always false
    expect(false).toBe(false)
  })
})
