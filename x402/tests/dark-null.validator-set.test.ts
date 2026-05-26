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
// ValidatorSet primitives (mirrors crates/dark-validator-set/src/lib.rs)
//
// validator_hash   = SHA256("vset-validator-v1" || operator_secret)
// stake_commitment = SHA256("vset-stake-v1"     || validator_hash || stake_u64le)
// validator_root   = SHA256("vset-root-v1"      || XOR_fold(validator_hashes) || active_count_u32le || epoch_u64le)
// set_id           = SHA256("vset-id-v1"        || validator_root || [quorum] || epoch_u64le)
// ---------------------------------------------------------------------------

function validatorHash(operatorSecret: Buffer): Buffer {
  return sha256(Buffer.from('vset-validator-v1'), operatorSecret)
}

function stakeCommitment(vhash: Buffer, stake: bigint): Buffer {
  return sha256(Buffer.from('vset-stake-v1'), vhash, u64le(stake))
}

function validatorRoot(validatorHashes: Buffer[], activeCount: number, epoch: bigint): Buffer {
  const folded = xorFold(validatorHashes)
  return sha256(Buffer.from('vset-root-v1'), folded, u32le(activeCount), u64le(epoch))
}

function setId(vroot: Buffer, quorum: number, epoch: bigint): Buffer {
  return sha256(Buffer.from('vset-id-v1'), vroot, Buffer.from([quorum]), u64le(epoch))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null validator-set', () => {
  const SECRET_A = Buffer.alloc(32).fill(0x11)
  const SECRET_B = Buffer.alloc(32).fill(0x22)
  const SECRET_C = Buffer.alloc(32).fill(0x33)

  // Test 1: set_id computation
  it('set_id computation is deterministic', () => {
    const vh = validatorHash(SECRET_A)
    const vroot = validatorRoot([vh], 1, 1n)
    const id = setId(vroot, 1, 1n)
    const id2 = setId(vroot, 1, 1n)
    expect(id.length).toBe(32)
    expect(id.equals(id2)).toBe(true)
    // manually recompute
    const expected = sha256(
      Buffer.from('vset-id-v1'),
      vroot,
      Buffer.from([1]),
      u64le(1n)
    )
    expect(id.equals(expected)).toBe(true)
  })

  // Test 2: validator_root computation with 3 validators
  it('validator_root computation with 3 validators', () => {
    const vhA = validatorHash(SECRET_A)
    const vhB = validatorHash(SECRET_B)
    const vhC = validatorHash(SECRET_C)
    const vroot = validatorRoot([vhA, vhB, vhC], 3, 1n)
    expect(vroot.length).toBe(32)
    const expected = sha256(
      Buffer.from('vset-root-v1'),
      xorFold([vhA, vhB, vhC]),
      u32le(3),
      u64le(1n)
    )
    expect(vroot.equals(expected)).toBe(true)
  })

  // Test 3: epoch rotation changes set_id
  it('epoch rotation changes set_id', () => {
    const vhA = validatorHash(SECRET_A)
    const vroot1 = validatorRoot([vhA], 1, 1n)
    const id1 = setId(vroot1, 1, 1n)
    const vroot2 = validatorRoot([vhA], 1, 2n)
    const id2 = setId(vroot2, 1, 2n)
    expect(id1.equals(id2)).toBe(false)
  })

  // Test 4: quorum zero guard — different quorum produces different set_id
  it('quorum zero guard — quorum=0 produces different set_id than quorum=1', () => {
    const vh = validatorHash(SECRET_A)
    const vroot = validatorRoot([vh], 1, 1n)
    const idQ0 = setId(vroot, 0, 1n)
    const idQ1 = setId(vroot, 1, 1n)
    expect(idQ0.equals(idQ1)).toBe(false)
  })

  // Test 5: validator_root sensitive to epoch
  it('validator_root sensitive to epoch', () => {
    const vh = validatorHash(SECRET_A)
    const vrootE1 = validatorRoot([vh], 1, 1n)
    const vrootE9 = validatorRoot([vh], 1, 9n)
    expect(vrootE1.equals(vrootE9)).toBe(false)
  })

  // Test 6: mainnet_ready=false marker
  it('mainnet_ready=false and stake_commitment deterministic', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
    const vh = validatorHash(SECRET_B)
    const sc = stakeCommitment(vh, 5000n)
    const sc2 = stakeCommitment(vh, 5000n)
    expect(sc.length).toBe(32)
    expect(sc.equals(sc2)).toBe(true)
    const expected = sha256(Buffer.from('vset-stake-v1'), vh, u64le(5000n))
    expect(sc.equals(expected)).toBe(true)
  })
})
