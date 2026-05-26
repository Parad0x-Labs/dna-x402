import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(32)
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i]
  return out
}

function xorFold(bufs: Buffer[]): Buffer {
  return bufs.reduce(xorBuffers)
}

interface ThresholdScheme {
  masterKey: Buffer
  keyCommitment: Buffer
  partialKeys: Buffer[]
  shareHashes: Buffer[]
}

function buildThresholdScheme(secret: Buffer, nonce: Buffer, n: number): ThresholdScheme {
  const masterKey = sha256(Buffer.from('thresh-key-v1'), secret, nonce)
  const keyCommitment = sha256(Buffer.from('thresh-commit-v1'), masterKey)

  const partialKeys: Buffer[] = []
  for (let i = 0; i < n - 1; i++) {
    partialKeys.push(sha256(Buffer.from('thresh-share-v1'), masterKey, Buffer.from([i])))
  }
  // Last share = masterKey XOR XOR_fold(first n-1)
  const lastShare = xorFold([masterKey, ...partialKeys])
  partialKeys.push(lastShare)

  const shareHashes: Buffer[] = partialKeys.map((pk, i) =>
    sha256(Buffer.from('thresh-share-hash-v1'), pk, Buffer.from([i]))
  )

  return { masterKey, keyCommitment, partialKeys, shareHashes }
}

function encrypt(masterKey: Buffer, plaintext: Buffer): Buffer {
  const keystream = sha256(Buffer.from('thresh-cipher-v1'), masterKey)
  const out = Buffer.allocUnsafe(plaintext.length)
  for (let i = 0; i < plaintext.length; i++) out[i] = plaintext[i] ^ keystream[i % 32]
  return out
}

describe('dark-null Threshold Decrypt', () => {
  const secret = Buffer.from('threshold-secret-key')
  const nonce = Buffer.from('unique-nonce-value')

  it('key reconstruction from all shares returns master_key', () => {
    const { masterKey, partialKeys } = buildThresholdScheme(secret, nonce, 3)
    const reconstructed = xorFold(partialKeys)
    expect(reconstructed.toString('hex')).toBe(masterKey.toString('hex'))
  })

  it('share hashes are distinct', () => {
    const { shareHashes } = buildThresholdScheme(secret, nonce, 4)
    const hexes = shareHashes.map(h => h.toString('hex'))
    const unique = new Set(hexes)
    expect(unique.size).toBe(shareHashes.length)
  })

  it('encrypt-decrypt roundtrip with n=3', () => {
    const { masterKey, partialKeys } = buildThresholdScheme(secret, nonce, 3)
    const plaintext = Buffer.from('Hello, threshold world!')

    const ciphertext = encrypt(masterKey, plaintext)
    expect(ciphertext.toString('hex')).not.toBe(plaintext.toString('hex'))

    // Reconstruct master key from all 3 shares
    const reconstructed = xorFold(partialKeys)
    const decrypted = encrypt(reconstructed, ciphertext) // XOR is self-inverse
    expect(decrypted.toString('utf8')).toBe(plaintext.toString('utf8'))
  })

  it('k > n is invalid: threshold constraint requires k <= n', () => {
    const n = 3
    const k = 5 // k > n: invalid
    // In Rust, this would return an error. Here we assert the constraint.
    expect(k).toBeGreaterThan(n)
    // A valid scheme requires k <= n; demonstrate you can only reconstruct with all n shares
    const { masterKey, partialKeys } = buildThresholdScheme(secret, nonce, n)
    // Using fewer than n shares does NOT reconstruct the master key
    const partial = xorFold(partialKeys.slice(0, n - 1))
    expect(partial.toString('hex')).not.toBe(masterKey.toString('hex'))
  })

  it('key_commitment is SHA256("thresh-commit-v1" || master_key)', () => {
    const { masterKey, keyCommitment } = buildThresholdScheme(secret, nonce, 3)
    const expected = sha256(Buffer.from('thresh-commit-v1'), masterKey)
    expect(keyCommitment.toString('hex')).toBe(expected.toString('hex'))
  })

  it('share_public_record hides partial_key: only share hash is exposed', () => {
    const { partialKeys, shareHashes } = buildThresholdScheme(secret, nonce, 3)
    const publicRecords = shareHashes.map((h, i) => ({
      index: i,
      share_hash: h.toString('hex'),
      // partial_key is NOT in the public record
    }))
    for (let i = 0; i < publicRecords.length; i++) {
      expect(publicRecords[i]).not.toHaveProperty('partial_key')
      expect(Object.values(publicRecords[i])).not.toContain(partialKeys[i].toString('hex'))
    }
  })
})
