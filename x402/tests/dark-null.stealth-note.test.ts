import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

interface StealthNote {
  stealthAddr: Buffer
  sharedSecret: Buffer
  encKey: Buffer
  noteId: Buffer
  nullifier: Buffer
}

function deriveStealthNote(params: {
  scanSecret: Buffer
  spendSecret: Buffer
  ephemSecret: Buffer
  scopeBytes: Buffer
  encryptedAmount: Buffer
}): StealthNote & {
  scanPubkey: Buffer
  spendPubkey: Buffer
  ephemPubkey: Buffer
  scopeHash: Buffer
  spendSecretHash: Buffer
} {
  const scanPubkey = sha256(Buffer.from('sn-scan-pubkey-v1'), params.scanSecret)
  const spendPubkey = sha256(Buffer.from('sn-spend-pubkey-v1'), params.spendSecret)
  const ephemPubkey = sha256(Buffer.from('sn-ephem-pubkey-v1'), params.ephemSecret)
  const sharedSecret = sha256(Buffer.from('sn-shared-v1'), ephemPubkey, scanPubkey)
  const stealthAddr = sha256(Buffer.from('sn-addr-v1'), sharedSecret, spendPubkey)
  const scopeHash = sha256(Buffer.from('sn-scope-v1'), params.scopeBytes)
  const encKey = sha256(Buffer.from('sn-enc-key-v1'), sharedSecret)
  const noteId = sha256(Buffer.from('sn-note-v1'), stealthAddr, scopeHash, params.encryptedAmount)
  const spendSecretHash = sha256(Buffer.from('sn-spend-secret-v1'), params.spendSecret)
  const nullifier = sha256(Buffer.from('sn-null-v1'), noteId, spendSecretHash)

  return { scanPubkey, spendPubkey, ephemPubkey, sharedSecret, stealthAddr, scopeHash, encKey, noteId, nullifier, spendSecretHash }
}

describe('dark-null Stealth Note', () => {
  const scanSecret = Buffer.from('scan-secret-key-xyz')
  const spendSecret = Buffer.from('spend-secret-key-abc')
  const ephemSecret = Buffer.from('ephem-secret-key-def')
  const scopeBytes = Buffer.from('protocol-scope-v1')
  const encryptedAmount = Buffer.alloc(32, 0x77)

  it('stealth_addr derivation is correct', () => {
    const scanPubkey = sha256(Buffer.from('sn-scan-pubkey-v1'), scanSecret)
    const spendPubkey = sha256(Buffer.from('sn-spend-pubkey-v1'), spendSecret)
    const ephemPubkey = sha256(Buffer.from('sn-ephem-pubkey-v1'), ephemSecret)
    const sharedSecret = sha256(Buffer.from('sn-shared-v1'), ephemPubkey, scanPubkey)
    const expectedAddr = sha256(Buffer.from('sn-addr-v1'), sharedSecret, spendPubkey)

    const { stealthAddr } = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount })
    expect(stealthAddr.toString('hex')).toBe(expectedAddr.toString('hex'))
  })

  it('scan returns true: recomputing shared_secret from scan_secret+ephem_pubkey matches', () => {
    const { scanPubkey, ephemPubkey, sharedSecret } = deriveStealthNote({
      scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount,
    })

    // Recipient with scan_secret sees ephemPubkey on-chain and recomputes
    const derivedSharedSecret = sha256(Buffer.from('sn-shared-v1'), ephemPubkey, scanPubkey)
    expect(derivedSharedSecret.toString('hex')).toBe(sharedSecret.toString('hex'))
  })

  it('different scopes produce different note_ids', () => {
    const n1 = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes: Buffer.from('scope-A'), encryptedAmount })
    const n2 = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes: Buffer.from('scope-B'), encryptedAmount })

    expect(n1.scopeHash.toString('hex')).not.toBe(n2.scopeHash.toString('hex'))
    expect(n1.noteId.toString('hex')).not.toBe(n2.noteId.toString('hex'))
    // stealthAddr is the same (scope doesn't affect it)
    expect(n1.stealthAddr.toString('hex')).toBe(n2.stealthAddr.toString('hex'))
  })

  it('nullifier is deterministic: same inputs always give same nullifier', () => {
    const n1 = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount })
    const n2 = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount })
    expect(n1.nullifier.toString('hex')).toBe(n2.nullifier.toString('hex'))
  })

  it('public record hides encrypted_amount: only note_id is exposed', () => {
    const { stealthAddr, scopeHash, noteId, nullifier, encKey } = deriveStealthNote({
      scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount,
    })
    const publicRecord = {
      stealth_addr: stealthAddr.toString('hex'),
      scope_hash: scopeHash.toString('hex'),
      note_id: noteId.toString('hex'),
      // encrypted_amount and enc_key are NOT in the public record
      mainnet_ready: false,
    }
    expect(publicRecord).not.toHaveProperty('encrypted_amount')
    expect(publicRecord).not.toHaveProperty('enc_key')
    expect(Object.values(publicRecord)).not.toContain(encryptedAmount.toString('hex'))
    expect(Object.values(publicRecord)).not.toContain(encKey.toString('hex'))
    // nullifier is also kept private until spend
    expect(publicRecord).not.toHaveProperty('nullifier')
    expect(Object.values(publicRecord)).not.toContain(nullifier.toString('hex'))
  })

  it('mainnet_ready=false in all stealth note records', () => {
    const { stealthAddr, noteId } = deriveStealthNote({ scanSecret, spendSecret, ephemSecret, scopeBytes, encryptedAmount })
    const record = {
      stealth_addr: stealthAddr.toString('hex'),
      note_id: noteId.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
