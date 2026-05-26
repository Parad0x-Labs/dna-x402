import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Pure-Node implementation of the stealth-address scheme
// Mirrors: crates/dark-stealth-address/src/lib.rs
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

function scanPubkey(scanSecret: Buffer): Buffer {
  return sha256(Buffer.from('stealth-scan-pubkey-v1'), scanSecret)
}

function spendPubkey(spendSecret: Buffer): Buffer {
  return sha256(Buffer.from('stealth-spend-pubkey-v1'), spendSecret)
}

function ephemeralPubkey(ephemeralSecret: Buffer): Buffer {
  return sha256(Buffer.from('stealth-ephem-v1'), ephemeralSecret)
}

function sharedSecretSender(ephPubkey: Buffer, scanPub: Buffer): Buffer {
  return sha256(Buffer.from('stealth-shared-v1'), ephPubkey, scanPub)
}

function sharedSecretRecipient(ephPubkey: Buffer, scanSecret: Buffer): Buffer {
  const scanPub = scanPubkey(scanSecret)
  return sha256(Buffer.from('stealth-shared-v1'), ephPubkey, scanPub)
}

function oneTimeAddress(shared: Buffer, spendPub: Buffer): Buffer {
  return sha256(Buffer.from('stealth-addr-v1'), shared, spendPub)
}

function amountCommitment(amount: bigint, ephSecret: Buffer): Buffer {
  const amountBuf = Buffer.alloc(8)
  amountBuf.writeBigUInt64LE(amount)
  return sha256(Buffer.from('stealth-amount-v1'), amountBuf, ephSecret)
}

// ---------------------------------------------------------------------------
// Helper: build the sender-side one-time address for a given recipient
// meta-address = { scanPub, spendPub }
// ---------------------------------------------------------------------------
interface StealthMetaAddress {
  scanPub: Buffer
  spendPub: Buffer
}

function sendToMetaAddress(
  meta: StealthMetaAddress,
  ephSecret: Buffer,
): { oneTimeAddr: Buffer; ephPub: Buffer; sharedSecret: Buffer } {
  const ephPub = ephemeralPubkey(ephSecret)
  const shared = sharedSecretSender(ephPub, meta.scanPub)
  const addr = oneTimeAddress(shared, meta.spendPub)
  return { oneTimeAddr: addr, ephPub, sharedSecret: shared }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null stealth address scheme', () => {
  it('happy path: send and scan roundtrip', () => {
    const scanSecret = Buffer.from('scan-secret-alice-v1')
    const spendSecret = Buffer.from('spend-secret-alice-v1')
    const ephSecret = Buffer.from('ephemeral-secret-tx1')

    const meta: StealthMetaAddress = {
      scanPub: scanPubkey(scanSecret),
      spendPub: spendPubkey(spendSecret),
    }

    // Sender constructs the one-time address
    const { oneTimeAddr, ephPub, sharedSecret: senderShared } = sendToMetaAddress(meta, ephSecret)

    // Recipient scans: recompute shared secret from their own scan secret
    const recipientShared = sharedSecretRecipient(ephPub, scanSecret)
    expect(recipientShared.equals(senderShared)).toBe(true)

    // Recipient reconstructs the expected one-time address
    const reconstructed = oneTimeAddress(recipientShared, meta.spendPub)
    expect(reconstructed.equals(oneTimeAddr)).toBe(true)
  })

  it('wrong scan secret fails: different scan_secret → address mismatch', () => {
    const scanSecret = Buffer.from('scan-secret-alice-v1')
    const wrongScanSecret = Buffer.from('scan-secret-eve-wrong')
    const spendSecret = Buffer.from('spend-secret-alice-v1')
    const ephSecret = Buffer.from('ephemeral-secret-tx2')

    const meta: StealthMetaAddress = {
      scanPub: scanPubkey(scanSecret),
      spendPub: spendPubkey(spendSecret),
    }

    const { oneTimeAddr, ephPub } = sendToMetaAddress(meta, ephSecret)

    // Wrong scanner gets a different shared secret
    const wrongShared = sharedSecretRecipient(ephPub, wrongScanSecret)
    const wrongAddr = oneTimeAddress(wrongShared, meta.spendPub)

    expect(wrongAddr.equals(oneTimeAddr)).toBe(false)
  })

  it('different ephemeral → different one_time_address for same recipient', () => {
    const scanSecret = Buffer.from('scan-secret-bob-v1')
    const spendSecret = Buffer.from('spend-secret-bob-v1')

    const meta: StealthMetaAddress = {
      scanPub: scanPubkey(scanSecret),
      spendPub: spendPubkey(spendSecret),
    }

    const { oneTimeAddr: addr1 } = sendToMetaAddress(meta, Buffer.from('eph-secret-tx-A'))
    const { oneTimeAddr: addr2 } = sendToMetaAddress(meta, Buffer.from('eph-secret-tx-B'))

    expect(addr1.equals(addr2)).toBe(false)
  })

  it('one_time_address is unique per ephemeral: 100 different secrets all distinct', () => {
    const scanSecret = Buffer.from('scan-secret-carol-v1')
    const spendSecret = Buffer.from('spend-secret-carol-v1')

    const meta: StealthMetaAddress = {
      scanPub: scanPubkey(scanSecret),
      spendPub: spendPubkey(spendSecret),
    }

    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const ephSecret = Buffer.from(`eph-secret-${i.toString().padStart(4, '0')}`)
      const { oneTimeAddr } = sendToMetaAddress(meta, ephSecret)
      const hex = oneTimeAddr.toString('hex')
      expect(seen.has(hex)).toBe(false)
      seen.add(hex)
    }
    expect(seen.size).toBe(100)
  })

  it('amount_commitment is deterministic: same amount + eph_secret always same result', () => {
    const amount = 1_000_000n
    const ephSecret = Buffer.from('eph-secret-determinism-test')

    const c1 = amountCommitment(amount, ephSecret)
    const c2 = amountCommitment(amount, ephSecret)

    expect(c1.equals(c2)).toBe(true)
    expect(c1).toHaveLength(32)
  })

  it('public record shape: JSON has ephemeral_pubkey_hex and amount_commitment_hex, no raw amount', () => {
    const scanSecret = Buffer.from('scan-secret-dave-v1')
    const spendSecret = Buffer.from('spend-secret-dave-v1')
    const ephSecret = Buffer.from('eph-secret-dave-tx1')
    const amount = 500_000n

    const meta: StealthMetaAddress = {
      scanPub: scanPubkey(scanSecret),
      spendPub: spendPubkey(spendSecret),
    }

    const { ephPub } = sendToMetaAddress(meta, ephSecret)
    const amtCommit = amountCommitment(amount, ephSecret)

    // Public record that goes on-chain / in logs
    const publicRecord = {
      ephemeral_pubkey_hex: ephPub.toString('hex'),
      amount_commitment_hex: amtCommit.toString('hex'),
    }

    const json = JSON.stringify(publicRecord)
    const parsed = JSON.parse(json) as Record<string, unknown>

    // Required fields present
    expect(typeof parsed['ephemeral_pubkey_hex']).toBe('string')
    expect(typeof parsed['amount_commitment_hex']).toBe('string')
    expect((parsed['ephemeral_pubkey_hex'] as string).length).toBe(64) // 32 bytes hex
    expect((parsed['amount_commitment_hex'] as string).length).toBe(64)

    // Raw amount must NOT appear
    expect(json).not.toContain('500000')
    expect(json).not.toContain('amount_raw')
    expect(json).not.toContain('"amount"')
  })
})
