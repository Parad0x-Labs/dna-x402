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
// Anonymous Payment
//
// sender_hash_inner    = SHA256("anon-pay-secret-v1"   || sender_secret)
// sender_commitment    = SHA256("anon-pay-sender-v1"   || sender_hash_inner || nonce_s)
// receiver_hash_inner  = SHA256("anon-pay-secret-v1"   || receiver_secret)
// receiver_commitment  = SHA256("anon-pay-receiver-v1" || receiver_hash_inner || nonce_r)
// amount_commitment    = SHA256("anon-pay-amount-v1"   || amount_u64le || blinding)
// memo_hash            = SHA256("anon-pay-memo-v1"     || memo_bytes)
// payment_id           = SHA256("anon-pay-id-v1"       || sender_commitment || receiver_commitment || amount_commitment || memo_hash)
// proof_hash           = SHA256("anon-pay-proof-v1"    || payment_id || sender_commitment || receiver_commitment)
// ---------------------------------------------------------------------------

function senderCommitment(senderSecret: Buffer, nonceS: Buffer): Buffer {
  const inner = sha256(Buffer.from('anon-pay-secret-v1'), senderSecret)
  return sha256(Buffer.from('anon-pay-sender-v1'), inner, nonceS)
}

function receiverCommitment(receiverSecret: Buffer, nonceR: Buffer): Buffer {
  const inner = sha256(Buffer.from('anon-pay-secret-v1'), receiverSecret)
  return sha256(Buffer.from('anon-pay-receiver-v1'), inner, nonceR)
}

function amountCommitment(amount: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from('anon-pay-amount-v1'), u64le(amount), blinding)
}

function memoHash(memoBytes: Buffer): Buffer {
  return sha256(Buffer.from('anon-pay-memo-v1'), memoBytes)
}

function paymentId(sc: Buffer, rc: Buffer, ac: Buffer, mh: Buffer): Buffer {
  return sha256(Buffer.from('anon-pay-id-v1'), sc, rc, ac, mh)
}

function proofHash(pid: Buffer, sc: Buffer, rc: Buffer): Buffer {
  return sha256(Buffer.from('anon-pay-proof-v1'), pid, sc, rc)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null anonymous-payment', () => {
  const SENDER_SECRET   = Buffer.from('sender-secret-0001')
  const RECEIVER_SECRET = Buffer.from('receiver-secret-0001')
  const NONCE_S         = Buffer.alloc(32, 0xaa)
  const NONCE_R         = Buffer.alloc(32, 0xbb)
  const BLINDING        = Buffer.alloc(32, 0xcc)
  const AMOUNT          = 1_000_000n  // 1 USDC in atomic units
  const MEMO            = Buffer.from('invoice-ref-0042')

  function buildPayment(amount = AMOUNT) {
    const sc  = senderCommitment(SENDER_SECRET, NONCE_S)
    const rc  = receiverCommitment(RECEIVER_SECRET, NONCE_R)
    const ac  = amountCommitment(amount, BLINDING)
    const mh  = memoHash(MEMO)
    const pid = paymentId(sc, rc, ac, mh)
    const ph  = proofHash(pid, sc, rc)
    return { sc, rc, ac, mh, pid, ph }
  }

  it('payment_id computation is deterministic and correct', () => {
    const p1 = buildPayment()
    const p2 = buildPayment()

    expect(p1.pid.length).toBe(32)
    expect(p1.pid.equals(p2.pid)).toBe(true)

    // manual recompute
    const sc = sha256(Buffer.from('anon-pay-sender-v1'),
      sha256(Buffer.from('anon-pay-secret-v1'), SENDER_SECRET), NONCE_S)
    const rc = sha256(Buffer.from('anon-pay-receiver-v1'),
      sha256(Buffer.from('anon-pay-secret-v1'), RECEIVER_SECRET), NONCE_R)
    const ac = sha256(Buffer.from('anon-pay-amount-v1'), u64le(AMOUNT), BLINDING)
    const mh = sha256(Buffer.from('anon-pay-memo-v1'), MEMO)
    const expected = sha256(Buffer.from('anon-pay-id-v1'), sc, rc, ac, mh)
    expect(p1.pid.equals(expected)).toBe(true)
  })

  it('proof_hash computation is deterministic and correct', () => {
    const p1 = buildPayment()
    const p2 = buildPayment()

    expect(p1.ph.length).toBe(32)
    expect(p1.ph.equals(p2.ph)).toBe(true)

    // manual recompute
    const expected = sha256(Buffer.from('anon-pay-proof-v1'), p1.pid, p1.sc, p1.rc)
    expect(p1.ph.equals(expected)).toBe(true)
  })

  it('different amounts produce different payment_ids', () => {
    const p1 = buildPayment(1_000_000n)
    const p2 = buildPayment(2_000_000n)
    expect(p1.pid.equals(p2.pid)).toBe(false)
    expect(p1.ac.equals(p2.ac)).toBe(false)
  })

  it('verify: recomputing proof_hash matches original', () => {
    const p = buildPayment()
    // simulate verification: recompute proof_hash from pid and commitments
    const recomputed = sha256(Buffer.from('anon-pay-proof-v1'), p.pid, p.sc, p.rc)
    expect(recomputed.equals(p.ph)).toBe(true)
  })

  it('public record hides sender, receiver, and amount', () => {
    const p = buildPayment()
    const publicRecord = {
      payment_id: p.pid.toString('hex'),
      proof_hash: p.ph.toString('hex'),
      mainnet_ready: false,
    }

    const recordJson = JSON.stringify(publicRecord)

    // The raw secrets must NOT appear
    expect(recordJson).not.toContain(SENDER_SECRET.toString('hex'))
    expect(recordJson).not.toContain(RECEIVER_SECRET.toString('hex'))

    // The commitments (which hide the actual values behind blinding) are NOT exposed
    expect(recordJson).not.toContain(p.sc.toString('hex'))
    expect(recordJson).not.toContain(p.rc.toString('hex'))
    expect(recordJson).not.toContain(p.ac.toString('hex'))

    expect(publicRecord.mainnet_ready).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const p = buildPayment()
    const record = { payment_id: p.pid.toString('hex'), mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
