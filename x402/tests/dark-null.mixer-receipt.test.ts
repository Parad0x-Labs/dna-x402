import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Pure-Node implementation of the coin mixer receipt scheme
// Mirrors: crates/dark-mixer-receipt/src/lib.rs
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

function denominationLE(denom: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(denom)
  return buf
}

// ---------------------------------------------------------------------------
// Denominations (u64 lamports)
// ---------------------------------------------------------------------------
const DENOM = {
  ONE: 1_000_000_000n,
  TEN: 10_000_000_000n,
  HUNDRED: 100_000_000_000n,
  THOUSAND: 1_000_000_000_000n,
} as const

// ---------------------------------------------------------------------------
// note_commitment = SHA256("mixer-note-v1" || denomination_le || secret)
// ---------------------------------------------------------------------------
function noteCommitment(denomination: bigint, secret: Buffer): Buffer {
  return sha256(Buffer.from('mixer-note-v1'), denominationLE(denomination), secret)
}

// ---------------------------------------------------------------------------
// Mixer pool accumulator
// pool_root starts as 32 zero bytes
// Each deposit XORs commitment into the accumulator, then:
//   pool_root = SHA256("mixer-pool-v1" || accumulator)
// ---------------------------------------------------------------------------
class MixerPool {
  private accumulator: Buffer = Buffer.alloc(32, 0)
  private _root: Buffer = sha256(Buffer.from('mixer-pool-v1'), Buffer.alloc(32, 0))

  get root(): Buffer {
    return Buffer.from(this._root)
  }

  deposit(commitment: Buffer): void {
    if (commitment.length !== 32) {
      throw new Error('commitment must be 32 bytes')
    }
    // XOR accumulator in place
    for (let i = 0; i < 32; i++) {
      this.accumulator[i] ^= commitment[i]
    }
    this._root = sha256(Buffer.from('mixer-pool-v1'), this.accumulator)
  }
}

// ---------------------------------------------------------------------------
// nullifier = SHA256("mixer-null-v1" || note_commitment || pool_root)
// ---------------------------------------------------------------------------
function nullifier(commitment: Buffer, poolRoot: Buffer): Buffer {
  return sha256(Buffer.from('mixer-null-v1'), commitment, poolRoot)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null mixer receipt', () => {
  it('happy path: deposit and withdraw produces valid nullifier', () => {
    const secret = Buffer.from('note-secret-alice-1')
    const denomination = DENOM.ONE

    const commitment = noteCommitment(denomination, secret)
    expect(commitment).toHaveLength(32)

    const pool = new MixerPool()
    pool.deposit(commitment)

    const rootAfterDeposit = pool.root
    expect(rootAfterDeposit).toHaveLength(32)

    const nul = nullifier(commitment, rootAfterDeposit)
    expect(nul).toHaveLength(32)

    // Nullifier must not be all-zeros (sanity)
    expect(nul.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('pool root changes on every deposit: 3 sequential deposits each distinct', () => {
    const pool = new MixerPool()
    const roots: string[] = []

    for (let i = 0; i < 3; i++) {
      const secret = Buffer.from(`deposit-secret-${i}`)
      const commitment = noteCommitment(DENOM.TEN, secret)
      pool.deposit(commitment)
      roots.push(pool.root.toString('hex'))
    }

    // All three roots must be distinct
    const unique = new Set(roots)
    expect(unique.size).toBe(3)
  })

  it('different denominations → different notes with same secret', () => {
    const secret = Buffer.from('same-secret-for-all-denoms')

    const c1 = noteCommitment(DENOM.ONE, secret)
    const c10 = noteCommitment(DENOM.TEN, secret)
    const c100 = noteCommitment(DENOM.HUNDRED, secret)
    const c1000 = noteCommitment(DENOM.THOUSAND, secret)

    const hexes = [c1, c10, c100, c1000].map((c) => c.toString('hex'))
    const unique = new Set(hexes)
    expect(unique.size).toBe(4)
  })

  it('nullifier is unique per pool state: same note produces different nullifier before and after another deposit', () => {
    const secret = Buffer.from('note-secret-state-test')
    const commitment = noteCommitment(DENOM.HUNDRED, secret)

    const pool = new MixerPool()

    // Deposit our note first, record root
    pool.deposit(commitment)
    const rootBefore = pool.root

    // Another note is deposited, changing pool state
    const otherCommitment = noteCommitment(DENOM.ONE, Buffer.from('other-note-secret'))
    pool.deposit(otherCommitment)
    const rootAfter = pool.root

    // Roots differ
    expect(rootBefore.equals(rootAfter)).toBe(false)

    // Same commitment yields different nullifier under different pool state
    const nul1 = nullifier(commitment, rootBefore)
    const nul2 = nullifier(commitment, rootAfter)
    expect(nul1.equals(nul2)).toBe(false)
  })

  it('note commitment is deterministic: same denomination + secret always same commitment', () => {
    const secret = Buffer.from('determinism-secret')
    const denomination = DENOM.THOUSAND

    const c1 = noteCommitment(denomination, secret)
    const c2 = noteCommitment(denomination, secret)
    const c3 = noteCommitment(denomination, secret)

    expect(c1.equals(c2)).toBe(true)
    expect(c2.equals(c3)).toBe(true)
  })

  it('double spend: same nullifier cannot be used twice (detected via Set)', () => {
    const secret = Buffer.from('note-secret-double-spend')
    const denomination = DENOM.TEN

    const commitment = noteCommitment(denomination, secret)

    const pool = new MixerPool()
    pool.deposit(commitment)
    const poolRoot = pool.root

    const spentNullifiers = new Set<string>()

    // First withdrawal — should succeed
    const nul = nullifier(commitment, poolRoot)
    const nulHex = nul.toString('hex')
    expect(spentNullifiers.has(nulHex)).toBe(false)
    spentNullifiers.add(nulHex)
    expect(spentNullifiers.has(nulHex)).toBe(true)

    // Second attempt with same note under same pool root — detected as double-spend
    const nul2 = nullifier(commitment, poolRoot)
    const nul2Hex = nul2.toString('hex')
    expect(spentNullifiers.has(nul2Hex)).toBe(true)
  })
})
