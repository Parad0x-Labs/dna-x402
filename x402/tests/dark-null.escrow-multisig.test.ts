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
// EscrowMultisig (mirrors crates/dark-escrow-multisig/src/lib.rs)
//
// signer_hash    = SHA256("msig-signer-v1"    || signer_secret)
// condition_hash = SHA256("msig-condition-v1" || condition_bytes)
// escrow_id      = SHA256("msig-escrow-v1"    || XOR_fold(signer_hashes) || amount_u64le || condition_hash || [threshold u8])
// approval_hash  = SHA256("msig-approve-v1"   || escrow_id || signer_hash)
//
// mainnet_ready = false always
// ---------------------------------------------------------------------------

interface EscrowMultisig {
  escrow_id: Buffer
  signer_hashes: Buffer[]
  condition_hash: Buffer
  amount: bigint
  threshold: number
  approvals: Buffer[]
  mainnet_ready: boolean
}

function computeSignerHash(signerSecret: Buffer): Buffer {
  return sha256(Buffer.from('msig-signer-v1'), signerSecret)
}

function computeConditionHash(conditionBytes: Buffer): Buffer {
  return sha256(Buffer.from('msig-condition-v1'), conditionBytes)
}

function computeEscrowId(signerHashes: Buffer[], amount: bigint, conditionHash: Buffer, threshold: number): Buffer {
  const xored = xorFold(signerHashes)
  return sha256(Buffer.from('msig-escrow-v1'), xored, u64le(amount), conditionHash, Buffer.from([threshold]))
}

function computeApprovalHash(escrowId: Buffer, signerHash: Buffer): Buffer {
  return sha256(Buffer.from('msig-approve-v1'), escrowId, signerHash)
}

function createEscrow(signerSecrets: Buffer[], amount: bigint, conditionBytes: Buffer, threshold: number): EscrowMultisig {
  const signerHashes = signerSecrets.map(computeSignerHash)
  const conditionHash = computeConditionHash(conditionBytes)
  const escrowId = computeEscrowId(signerHashes, amount, conditionHash, threshold)
  return { escrow_id: escrowId, signer_hashes: signerHashes, condition_hash: conditionHash, amount, threshold, approvals: [], mainnet_ready: false }
}

function addApproval(escrow: EscrowMultisig, signerSecret: Buffer): Buffer {
  const signerHash = computeSignerHash(signerSecret)
  const approval = computeApprovalHash(escrow.escrow_id, signerHash)
  escrow.approvals.push(approval)
  return approval
}

function isApproved(escrow: EscrowMultisig): boolean {
  return escrow.approvals.length >= escrow.threshold
}

function escrowPublicRecord(escrow: EscrowMultisig): object {
  return {
    escrow_id: escrow.escrow_id.toString('hex'),
    condition_hash: escrow.condition_hash.toString('hex'),
    amount: escrow.amount.toString(),
    threshold: escrow.threshold,
    approval_count: escrow.approvals.length,
    mainnet_ready: escrow.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null escrow-multisig', () => {
  const SECRET_A = Buffer.alloc(32); SECRET_A[0] = 0x11
  const SECRET_B = Buffer.alloc(32); SECRET_B[0] = 0x22
  const SECRET_C = Buffer.alloc(32); SECRET_C[0] = 0x33
  const CONDITION = Buffer.from('release-on-delivery')
  const AMOUNT = 5000n

  it('escrow_id computation is correct', () => {
    const escrow = createEscrow([SECRET_A, SECRET_B, SECRET_C], AMOUNT, CONDITION, 2)
    const signerHashes = [SECRET_A, SECRET_B, SECRET_C].map(s => computeSignerHash(s))
    const conditionHash = computeConditionHash(CONDITION)
    const expectedId = computeEscrowId(signerHashes, AMOUNT, conditionHash, 2)
    expect(escrow.escrow_id.equals(expectedId)).toBe(true)
    expect(escrow.escrow_id.length).toBe(32)
  })

  it('approval_hash computation is correct', () => {
    const escrow = createEscrow([SECRET_A, SECRET_B], AMOUNT, CONDITION, 2)
    const approval = addApproval(escrow, SECRET_A)
    const signerHash = computeSignerHash(SECRET_A)
    const expected = computeApprovalHash(escrow.escrow_id, signerHash)
    expect(approval.equals(expected)).toBe(true)
  })

  it('2-of-3 threshold: 2 approvals passes, 1 does not', () => {
    const escrow = createEscrow([SECRET_A, SECRET_B, SECRET_C], AMOUNT, CONDITION, 2)
    expect(isApproved(escrow)).toBe(false)
    addApproval(escrow, SECRET_A)
    expect(isApproved(escrow)).toBe(false)
    addApproval(escrow, SECRET_B)
    expect(isApproved(escrow)).toBe(true)
  })

  it('different thresholds produce different escrow_ids', () => {
    const e1 = createEscrow([SECRET_A, SECRET_B], AMOUNT, CONDITION, 1)
    const e2 = createEscrow([SECRET_A, SECRET_B], AMOUNT, CONDITION, 2)
    expect(e1.escrow_id.equals(e2.escrow_id)).toBe(false)
  })

  it('public record hides signer secrets and signer_hashes', () => {
    const escrow = createEscrow([SECRET_A, SECRET_B, SECRET_C], AMOUNT, CONDITION, 2)
    const rec = escrowPublicRecord(escrow) as Record<string, unknown>
    expect(rec['escrow_id']).toBe(escrow.escrow_id.toString('hex'))
    expect(rec['mainnet_ready']).toBe(false)
    expect(rec['signer_hashes']).toBeUndefined()
  })

  it('mainnet_ready=false always', () => {
    const escrow = createEscrow([SECRET_A, SECRET_B], AMOUNT, CONDITION, 2)
    expect(escrow.mainnet_ready).toBe(false)
  })
})
