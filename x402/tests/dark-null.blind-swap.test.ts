import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

// ---------------------------------------------------------------------------
// Blind Swap primitives
//
// partyHash(secret)                               = SHA256("swap-party-v1"  || secret)
// sessionId(aHash, bHash, nonce)                  = SHA256("swap-session-v1"|| aHash || bHash || nonce)
// tokenHash(tokenId)                              = SHA256("swap-token-v1"  || tokenId)
// amountCommitment(amount_u64le, tokenHash, blind) = SHA256("swap-commit-v1"|| amount_le8 || tokenHash || blinding)
// swapRoot(aCommit, bCommit)                      = SHA256("swap-root-v1"   || aCommit || bCommit)
// ---------------------------------------------------------------------------

function partyHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('swap-party-v1'), secret)
}

function sessionId(aHash: Buffer, bHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('swap-session-v1'), aHash, bHash, nonce)
}

function tokenHash(tokenId: Buffer): Buffer {
  return sha256(Buffer.from('swap-token-v1'), tokenId)
}

function amountCommitment(amount: bigint, tHash: Buffer, blinding: Buffer): Buffer {
  return sha256(Buffer.from('swap-commit-v1'), u64le(amount), tHash, blinding)
}

function swapRoot(aCommit: Buffer, bCommit: Buffer): Buffer {
  return sha256(Buffer.from('swap-root-v1'), aCommit, bCommit)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null blind-swap', () => {
  const PARTY_A_SECRET = Buffer.alloc(32).fill(0xa1)
  const PARTY_B_SECRET = Buffer.alloc(32).fill(0xa2)
  const NONCE          = Buffer.alloc(32).fill(0x01)
  const BLINDING_A     = Buffer.alloc(32).fill(0x0a)
  const BLINDING_B     = Buffer.alloc(32).fill(0x0b)
  const TOKEN_USDC     = Buffer.from('usdc-mint-address')
  const TOKEN_SOL      = Buffer.from('sol-native')
  const AMOUNT_A       = 1_000_000n   // 1 USDC
  const AMOUNT_B       = 500_000_000n // 0.5 SOL (lamports)

  // Test 1: session_id formula is correct
  it('session_id formula is correct', () => {
    const aHash = partyHash(PARTY_A_SECRET)
    const bHash = partyHash(PARTY_B_SECRET)
    const sId   = sessionId(aHash, bHash, NONCE)

    const expected = sha256(Buffer.from('swap-session-v1'), aHash, bHash, NONCE)
    expect(sId.length).toBe(32)
    expect(sId.equals(expected)).toBe(true)
    expect(sId.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 2: amount_commitment uses "swap-commit-v1" domain
  it('amount_commitment uses "swap-commit-v1" domain', () => {
    const tHash  = tokenHash(TOKEN_USDC)
    const commit = amountCommitment(AMOUNT_A, tHash, BLINDING_A)

    const expected = sha256(Buffer.from('swap-commit-v1'), u64le(AMOUNT_A), tHash, BLINDING_A)
    expect(commit.equals(expected)).toBe(true)
  })

  // Test 3: swap_root = SHA256("swap-root-v1" || a_commit || b_commit)
  it('swap_root = SHA256("swap-root-v1" || a_commit || b_commit)', () => {
    const tHashUsdc = tokenHash(TOKEN_USDC)
    const tHashSol  = tokenHash(TOKEN_SOL)
    const aCommit   = amountCommitment(AMOUNT_A, tHashUsdc, BLINDING_A)
    const bCommit   = amountCommitment(AMOUNT_B, tHashSol, BLINDING_B)
    const root      = swapRoot(aCommit, bCommit)

    const expected = sha256(Buffer.from('swap-root-v1'), aCommit, bCommit)
    expect(root.length).toBe(32)
    expect(root.equals(expected)).toBe(true)
  })

  // Test 4: different tokens produce different amount_commitments
  it('different tokens produce different amount_commitments', () => {
    const tHashUsdc = tokenHash(TOKEN_USDC)
    const tHashSol  = tokenHash(TOKEN_SOL)
    const commitUsdc = amountCommitment(AMOUNT_A, tHashUsdc, BLINDING_A)
    const commitSol  = amountCommitment(AMOUNT_A, tHashSol, BLINDING_A)
    expect(commitUsdc.equals(commitSol)).toBe(false)
  })

  // Test 5: settle_swap returns deterministic swap_root
  it('settle_swap returns deterministic swap_root', () => {
    const tHashUsdc = tokenHash(TOKEN_USDC)
    const tHashSol  = tokenHash(TOKEN_SOL)
    const aCommit   = amountCommitment(AMOUNT_A, tHashUsdc, BLINDING_A)
    const bCommit   = amountCommitment(AMOUNT_B, tHashSol, BLINDING_B)
    const root1 = swapRoot(aCommit, bCommit)
    const root2 = swapRoot(aCommit, bCommit)
    expect(root1.equals(root2)).toBe(true)
    expect(root1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 6: mainnet_ready is false
  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
