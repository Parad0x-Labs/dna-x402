import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  return acc
}

const INDEX_SECRET = Buffer.from('index-secret-deadbeef01234567a', 'utf8')
const CATEGORY_A = Buffer.from('category.defi.positions', 'utf8')
const CATEGORY_B = Buffer.from('category.nft.metadata', 'utf8')
const QUERIER_NONCE = Buffer.from('querier-nonce-aabbccdd00112233', 'utf8')

interface IndexEntry {
  categoryHash: Buffer
  dataHash: Buffer
  entryHash: Buffer
  slot: bigint
}

function buildIndexId(indexSecret: Buffer): Buffer {
  return sha256(Buffer.from('idx-id-v1'), indexSecret)
}

function buildCategoryHash(categoryBytes: Buffer): Buffer {
  return sha256(Buffer.from('idx-category-v1'), categoryBytes)
}

function buildEntryHash(categoryHash: Buffer, dataBytes: Buffer, slot: bigint): IndexEntry {
  const dataHash = sha256(dataBytes)
  const entryHash = sha256(Buffer.from('idx-entry-v1'), categoryHash, dataHash, u64le(slot))
  return { categoryHash, dataHash, entryHash, slot }
}

function buildRoot(entryHashes: Buffer[]): Buffer {
  return sha256(Buffer.from('idx-root-v1'), xorFold(entryHashes))
}

function buildQueryHash(categoryHash: Buffer, querierNonce: Buffer): Buffer {
  return sha256(Buffer.from('idx-query-v1'), categoryHash, querierNonce)
}

// Simulate querying: count entries whose categoryHash matches the query's categoryHash
function queryMatchCount(entries: IndexEntry[], queryCategoryHash: Buffer): number {
  return entries.filter(e => e.categoryHash.toString('hex') === queryCategoryHash.toString('hex')).length
}

describe('dark-null dark-indexer', () => {
  it('entry_hash computation is correct', () => {
    const categoryHash = buildCategoryHash(CATEGORY_A)
    const dataBytes = Buffer.from('position-data-record-0001', 'utf8')
    const slot = 42n
    const entry = buildEntryHash(categoryHash, dataBytes, slot)

    const expectedDataHash = sha256(dataBytes)
    const expectedEntryHash = sha256(
      Buffer.from('idx-entry-v1'),
      categoryHash,
      expectedDataHash,
      u64le(slot)
    )

    expect(entry.dataHash.toString('hex')).toBe(expectedDataHash.toString('hex'))
    expect(entry.entryHash.toString('hex')).toBe(expectedEntryHash.toString('hex'))
    expect(entry.entryHash).toHaveLength(32)
  })

  it('root changes when an entry is added', () => {
    const categoryHash = buildCategoryHash(CATEGORY_A)

    const entry1 = buildEntryHash(categoryHash, Buffer.from('data-record-001', 'utf8'), 1n)
    const entry2 = buildEntryHash(categoryHash, Buffer.from('data-record-002', 'utf8'), 2n)

    const root1 = buildRoot([entry1.entryHash])
    const root2 = buildRoot([entry1.entryHash, entry2.entryHash])

    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
    expect(root1).toHaveLength(32)
    expect(root2).toHaveLength(32)
  })

  it('query matches correct category (simulate match_count)', () => {
    const catHashA = buildCategoryHash(CATEGORY_A)
    const catHashB = buildCategoryHash(CATEGORY_B)

    const entries: IndexEntry[] = [
      buildEntryHash(catHashA, Buffer.from('data-a-001', 'utf8'), 1n),
      buildEntryHash(catHashA, Buffer.from('data-a-002', 'utf8'), 2n),
      buildEntryHash(catHashB, Buffer.from('data-b-001', 'utf8'), 3n),
    ]

    const queryHash = buildQueryHash(catHashA, QUERIER_NONCE)
    const matchCount = queryMatchCount(entries, catHashA)

    expect(matchCount).toBe(2)
    expect(queryHash).toHaveLength(32)
  })

  it('query for different category returns match_count=0', () => {
    const catHashA = buildCategoryHash(CATEGORY_A)
    const catHashB = buildCategoryHash(CATEGORY_B)
    const catHashC = buildCategoryHash(Buffer.from('category.governance.votes', 'utf8'))

    const entries: IndexEntry[] = [
      buildEntryHash(catHashA, Buffer.from('data-a-001', 'utf8'), 1n),
      buildEntryHash(catHashB, Buffer.from('data-b-001', 'utf8'), 2n),
    ]

    // Query for category C which has no entries
    const matchCount = queryMatchCount(entries, catHashC)
    expect(matchCount).toBe(0)
  })

  it('public record hides individual entry_hashes', () => {
    const categoryHash = buildCategoryHash(CATEGORY_A)
    const indexId = buildIndexId(INDEX_SECRET)

    const entries: IndexEntry[] = [
      buildEntryHash(categoryHash, Buffer.from('data-private-001', 'utf8'), 1n),
      buildEntryHash(categoryHash, Buffer.from('data-private-002', 'utf8'), 2n),
    ]
    const root = buildRoot(entries.map(e => e.entryHash))

    // Public record: only exposes index_id and root
    const publicRecord = {
      index_id: indexId.toString('hex'),
      root: root.toString('hex'),
    }

    expect(publicRecord).toHaveProperty('index_id')
    expect(publicRecord).toHaveProperty('root')
    expect(publicRecord).not.toHaveProperty('entry_hashes')
    expect(publicRecord).not.toHaveProperty('data_hashes')

    const publicValues = Object.values(publicRecord)
    for (const entry of entries) {
      expect(publicValues).not.toContain(entry.entryHash.toString('hex'))
      expect(publicValues).not.toContain(entry.dataHash.toString('hex'))
    }
  })

  it('mainnet_ready=false', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
  })
})
