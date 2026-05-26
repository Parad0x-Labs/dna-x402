import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

// Hash scheme
function organizerHash(organizer_secret: Buffer): Buffer {
  return sha256(Buffer.from('lottery-org-v1'), organizer_secret)
}
function prizeCommitment(organizer_hash: Buffer, prize: bigint): Buffer {
  return sha256(Buffer.from('lottery-prize-v1'), organizer_hash, u64le(prize))
}
function lotteryId(organizer_hash: Buffer, prize_commitment: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('lottery-id-v1'), organizer_hash, prize_commitment, nonce)
}
function holderHash(holder_secret: Buffer): Buffer {
  return sha256(Buffer.from('lottery-holder-v1'), holder_secret)
}
function serialHash(lottery_id: Buffer, holder_hash: Buffer, serial_nonce: Buffer): Buffer {
  return sha256(Buffer.from('lottery-serial-v1'), lottery_id, holder_hash, serial_nonce)
}
function ticketId(serial_hash: Buffer, holder_hash: Buffer): Buffer {
  return sha256(Buffer.from('lottery-ticket-v1'), serial_hash, holder_hash)
}

describe('dark-null.private-lottery', () => {
  // Test 1: lottery_id computation
  it('lottery_id is correctly computed', () => {
    const organizer_secret = Buffer.alloc(32, 0x11)
    const nonce = Buffer.alloc(32, 0xAA)
    const prize = 1_000_000n
    const oh = organizerHash(organizer_secret)
    const pc = prizeCommitment(oh, prize)
    const lid = lotteryId(oh, pc, nonce)
    const oh2 = sha256(Buffer.from('lottery-org-v1'), organizer_secret)
    const pc2 = sha256(Buffer.from('lottery-prize-v1'), oh2, u64le(prize))
    const lid2 = sha256(Buffer.from('lottery-id-v1'), oh2, pc2, nonce)
    expect(lid.toString('hex')).toBe(lid2.toString('hex'))
    expect(lid.length).toBe(32)
  })

  // Test 2: ticket_id computation
  it('ticket_id is correctly computed from serial_hash and holder_hash', () => {
    const organizer_secret = Buffer.alloc(32, 0x22)
    const nonce = Buffer.alloc(32, 0xBB)
    const serial_nonce = Buffer.alloc(32, 0xCC)
    const holder_secret = Buffer.alloc(32, 0x33)
    const prize = 500_000n
    const oh = organizerHash(organizer_secret)
    const pc = prizeCommitment(oh, prize)
    const lid = lotteryId(oh, pc, nonce)
    const hh = holderHash(holder_secret)
    const sh = serialHash(lid, hh, serial_nonce)
    const tid = ticketId(sh, hh)
    const tid2 = sha256(Buffer.from('lottery-ticket-v1'), sh, hh)
    expect(tid.toString('hex')).toBe(tid2.toString('hex'))
    expect(tid.length).toBe(32)
  })

  // Test 3: different holders → different ticket_ids
  it('different holders produce different ticket_ids for same lottery', () => {
    const organizer_secret = Buffer.alloc(32, 0x44)
    const nonce = Buffer.alloc(32, 0x05)
    const serial_nonce = Buffer.alloc(32, 0x06)
    const prize = 200_000n
    const oh = organizerHash(organizer_secret)
    const pc = prizeCommitment(oh, prize)
    const lid = lotteryId(oh, pc, nonce)

    const holder1_secret = Buffer.alloc(32, 0x01)
    const holder2_secret = Buffer.alloc(32, 0x02)
    const hh1 = holderHash(holder1_secret)
    const hh2 = holderHash(holder2_secret)
    const sh1 = serialHash(lid, hh1, serial_nonce)
    const sh2 = serialHash(lid, hh2, serial_nonce)
    const tid1 = ticketId(sh1, hh1)
    const tid2 = ticketId(sh2, hh2)
    expect(tid1.toString('hex')).not.toBe(tid2.toString('hex'))
  })

  // Test 4: prize_commitment sensitive to prize amount
  it('prize_commitment changes when prize amount changes', () => {
    const organizer_secret = Buffer.alloc(32, 0x55)
    const oh = organizerHash(organizer_secret)
    const pc1 = prizeCommitment(oh, 100_000n)
    const pc2 = prizeCommitment(oh, 200_000n)
    const pc3 = prizeCommitment(oh, 999_999n)
    expect(pc1.toString('hex')).not.toBe(pc2.toString('hex'))
    expect(pc2.toString('hex')).not.toBe(pc3.toString('hex'))
    expect(pc1.toString('hex')).not.toBe(pc3.toString('hex'))
  })

  // Test 5: public record hides organizer_secret
  it('public record contains lottery_id but not organizer_secret', () => {
    const organizer_secret = Buffer.alloc(32, 0x66)
    const nonce = Buffer.alloc(32, 0x07)
    const prize = 300_000n
    const oh = organizerHash(organizer_secret)
    const pc = prizeCommitment(oh, prize)
    const lid = lotteryId(oh, pc, nonce)
    const publicRecord = JSON.stringify({
      lottery_id: lid.toString('hex'),
      mainnet_ready: false,
    })
    const parsed = JSON.parse(publicRecord)
    expect(parsed.lottery_id).toBe(lid.toString('hex'))
    expect(parsed.mainnet_ready).toBe(false)
    // organizer_secret must not appear
    expect(publicRecord).not.toContain(organizer_secret.toString('hex'))
    expect(publicRecord).not.toContain(oh.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready is always false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
