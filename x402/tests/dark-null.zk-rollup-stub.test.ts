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
// ZkRollupStub (mirrors crates/dark-zk-rollup-stub/src/lib.rs)
//
// tx_hash      = SHA256("rollup-tx-v1" || sender_hash || receiver_hash || amount_u64le)
// tx_root      = SHA256("rollup-tx-root-v1" || XOR_fold(tx_hashes) || count_u32le)
// state_root   = SHA256("rollup-state-v1" || prev_state_root || tx_root)
// proof_hash   = SHA256("rollup-proof-v1" || operator_key || tx_root || state_root)
// batch_id     = SHA256("rollup-batch-v1" || proof_hash || count_u32le)
//
// is_stub = true, mainnet_ready = false always
// MAX_BATCH_TXS = 64
// ---------------------------------------------------------------------------

const MAX_BATCH_TXS = 64

interface RollupTx {
  tx_hash: Buffer
  sender_hash: Buffer
  receiver_hash: Buffer
  amount: bigint
}

interface RollupBatch {
  batch_id: Buffer
  tx_root: Buffer
  state_root: Buffer
  proof_hash: Buffer
  tx_count: number
  is_stub: boolean
  mainnet_ready: boolean
}

function computeTxHash(senderHash: Buffer, receiverHash: Buffer, amount: bigint): Buffer {
  return sha256(Buffer.from('rollup-tx-v1'), senderHash, receiverHash, u64le(amount))
}

function computeTxRoot(txHashes: Buffer[], count: number): Buffer {
  const xored = xorFold(txHashes)
  return sha256(Buffer.from('rollup-tx-root-v1'), xored, u32le(count))
}

function computeStateRoot(prevStateRoot: Buffer, txRoot: Buffer): Buffer {
  return sha256(Buffer.from('rollup-state-v1'), prevStateRoot, txRoot)
}

function computeProofHash(operatorKey: Buffer, txRoot: Buffer, stateRoot: Buffer): Buffer {
  return sha256(Buffer.from('rollup-proof-v1'), operatorKey, txRoot, stateRoot)
}

function computeBatchId(proofHash: Buffer, count: number): Buffer {
  return sha256(Buffer.from('rollup-batch-v1'), proofHash, u32le(count))
}

function createBatch(operatorKey: Buffer, txs: RollupTx[], prevStateRoot: Buffer): RollupBatch {
  if (txs.length === 0) throw new Error('EmptyBatch')
  if (txs.length > MAX_BATCH_TXS) throw new Error('TooManyTxs')
  const count = txs.length
  const txHashes = txs.map(t => t.tx_hash)
  const txRoot = computeTxRoot(txHashes, count)
  const stateRoot = computeStateRoot(prevStateRoot, txRoot)
  const proofHash = computeProofHash(operatorKey, txRoot, stateRoot)
  const batchId = computeBatchId(proofHash, count)
  return { batch_id: batchId, tx_root: txRoot, state_root: stateRoot, proof_hash: proofHash, tx_count: count, is_stub: true, mainnet_ready: false }
}

function verifyBatch(batch: RollupBatch, operatorKey: Buffer): boolean {
  const expectedProof = computeProofHash(operatorKey, batch.tx_root, batch.state_root)
  if (!expectedProof.equals(batch.proof_hash)) return false
  const expectedId = computeBatchId(batch.proof_hash, batch.tx_count)
  return expectedId.equals(batch.batch_id)
}

function makeTx(a: number, b: number, amount: bigint): RollupTx {
  const sh = Buffer.alloc(32); sh[0] = a
  const rh = Buffer.alloc(32); rh[0] = b
  return { tx_hash: computeTxHash(sh, rh, amount), sender_hash: sh, receiver_hash: rh, amount }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zk-rollup-stub', () => {
  const OP_KEY = Buffer.alloc(32).fill(0xde)
  const PREV_ROOT = Buffer.alloc(32); PREV_ROOT[0] = 0x01

  it('batch_id computation is correct and verify passes', () => {
    const txs = [makeTx(1, 2, 1000n), makeTx(3, 4, 2000n)]
    const batch = createBatch(OP_KEY, txs, PREV_ROOT)
    expect(batch.batch_id.length).toBe(32)
    expect(batch.is_stub).toBe(true)
    expect(batch.mainnet_ready).toBe(false)
    expect(verifyBatch(batch, OP_KEY)).toBe(true)
  })

  it('verify recomputes proof_hash correctly', () => {
    const txs = [makeTx(5, 6, 500n)]
    const batch = createBatch(OP_KEY, txs, PREV_ROOT)
    const expectedProof = computeProofHash(OP_KEY, batch.tx_root, batch.state_root)
    expect(expectedProof.equals(batch.proof_hash)).toBe(true)
    expect(verifyBatch(batch, OP_KEY)).toBe(true)
  })

  it('tx_root is sensitive to transaction content', () => {
    const txs1 = [makeTx(1, 2, 100n)]
    const txs2 = [makeTx(5, 6, 999n)]
    const b1 = createBatch(OP_KEY, txs1, PREV_ROOT)
    const b2 = createBatch(OP_KEY, txs2, PREV_ROOT)
    expect(b1.tx_root.equals(b2.tx_root)).toBe(false)
    expect(b1.batch_id.equals(b2.batch_id)).toBe(false)
  })

  it('different prev_state_roots produce different state_roots', () => {
    const txs = [makeTx(1, 2, 100n)]
    const prevA = Buffer.alloc(32); prevA[0] = 0xaa
    const prevB = Buffer.alloc(32); prevB[0] = 0xbb
    const b1 = createBatch(OP_KEY, txs, prevA)
    const b2 = createBatch(OP_KEY, txs, prevB)
    expect(b1.state_root.equals(b2.state_root)).toBe(false)
  })

  it('is_stub=true and mainnet_ready=false always', () => {
    const txs = [makeTx(1, 2, 1n)]
    const batch = createBatch(OP_KEY, txs, PREV_ROOT)
    expect(batch.is_stub).toBe(true)
    expect(batch.mainnet_ready).toBe(false)
  })

  it('MAX_BATCH_TXS is 64 and over-limit throws', () => {
    expect(MAX_BATCH_TXS).toBe(64)
    const txs = Array.from({ length: 65 }, (_, i) => makeTx(i % 256, (i + 1) % 256, BigInt(i + 1)))
    expect(() => createBatch(OP_KEY, txs, PREV_ROOT)).toThrow('TooManyTxs')
  })
})
