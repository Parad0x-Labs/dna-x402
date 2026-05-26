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
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// ---------------------------------------------------------------------------
// PrivateNft (mirrors crates/dark-private-nft/src/lib.rs)
//
// owner_hash    = SHA256("nft-owner-v1" || owner_secret)
// metadata_hash = SHA256("nft-meta-v1"  || metadata_bytes)
// token_id      = SHA256("nft-token-v1" || owner_hash || metadata_hash || edition_u32le || nonce)
// nullifier     = SHA256("nft-null-v1"  || token_id || owner_hash)
//
// mainnet_ready = false always
// ---------------------------------------------------------------------------

interface PrivateNft {
  token_id: Buffer
  owner_hash: Buffer
  metadata_hash: Buffer
  nullifier: Buffer
  edition: number
  mainnet_ready: boolean
}

function computeOwnerHash(ownerSecret: Buffer): Buffer {
  return sha256(Buffer.from('nft-owner-v1'), ownerSecret)
}

function computeMetadataHash(metadataBytes: Buffer): Buffer {
  return sha256(Buffer.from('nft-meta-v1'), metadataBytes)
}

function computeTokenId(ownerHash: Buffer, metadataHash: Buffer, edition: number, nonce: Buffer): Buffer {
  return sha256(Buffer.from('nft-token-v1'), ownerHash, metadataHash, u32le(edition), nonce)
}

function computeNullifier(tokenId: Buffer, ownerHash: Buffer): Buffer {
  return sha256(Buffer.from('nft-null-v1'), tokenId, ownerHash)
}

function mintNft(ownerSecret: Buffer, metadataBytes: Buffer, edition: number, nonce: Buffer): PrivateNft {
  const ownerHash = computeOwnerHash(ownerSecret)
  const metadataHash = computeMetadataHash(metadataBytes)
  const tokenId = computeTokenId(ownerHash, metadataHash, edition, nonce)
  const nullifier = computeNullifier(tokenId, ownerHash)
  return { token_id: tokenId, owner_hash: ownerHash, metadata_hash: metadataHash, nullifier, edition, mainnet_ready: false }
}

function nftPublicRecord(nft: PrivateNft): object {
  return {
    token_id: nft.token_id.toString('hex'),
    metadata_hash: nft.metadata_hash.toString('hex'),
    edition: nft.edition,
    mainnet_ready: nft.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null private-nft', () => {
  const OWNER_SECRET = Buffer.alloc(32); OWNER_SECRET[0] = 0x11
  const METADATA = Buffer.from('{"name":"DarkNFT","rarity":"rare"}')
  const NONCE = Buffer.alloc(32); NONCE[0] = 0x99
  const EDITION = 1

  it('token_id computation is correct', () => {
    const nft = mintNft(OWNER_SECRET, METADATA, EDITION, NONCE)
    const ownerHash = computeOwnerHash(OWNER_SECRET)
    const metaHash = computeMetadataHash(METADATA)
    const expectedId = computeTokenId(ownerHash, metaHash, EDITION, NONCE)
    expect(nft.token_id.equals(expectedId)).toBe(true)
    expect(nft.token_id.length).toBe(32)
  })

  it('nullifier computation is correct', () => {
    const nft = mintNft(OWNER_SECRET, METADATA, EDITION, NONCE)
    const ownerHash = computeOwnerHash(OWNER_SECRET)
    const expectedNull = computeNullifier(nft.token_id, ownerHash)
    expect(nft.nullifier.equals(expectedNull)).toBe(true)
    expect(nft.nullifier.length).toBe(32)
  })

  it('different owners produce different token_ids', () => {
    const ownerA = Buffer.alloc(32); ownerA[0] = 0x11
    const ownerB = Buffer.alloc(32); ownerB[0] = 0x22
    const nft1 = mintNft(ownerA, METADATA, EDITION, NONCE)
    const nft2 = mintNft(ownerB, METADATA, EDITION, NONCE)
    expect(nft1.token_id.equals(nft2.token_id)).toBe(false)
  })

  it('different editions produce different token_ids', () => {
    const nft1 = mintNft(OWNER_SECRET, METADATA, 1, NONCE)
    const nft2 = mintNft(OWNER_SECRET, METADATA, 2, NONCE)
    expect(nft1.token_id.equals(nft2.token_id)).toBe(false)
  })

  it('public record hides owner_hash', () => {
    const nft = mintNft(OWNER_SECRET, METADATA, EDITION, NONCE)
    const rec = nftPublicRecord(nft) as Record<string, unknown>
    expect(rec['token_id']).toBe(nft.token_id.toString('hex'))
    expect(rec['metadata_hash']).toBe(nft.metadata_hash.toString('hex'))
    expect(rec['mainnet_ready']).toBe(false)
    expect(rec['owner_hash']).toBeUndefined()
  })

  it('mainnet_ready=false always', () => {
    const nft = mintNft(OWNER_SECRET, METADATA, EDITION, NONCE)
    expect(nft.mainnet_ready).toBe(false)
  })
})
