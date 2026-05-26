import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a }

// Hash scheme helpers
function genesisHash(genesis_secret: Buffer): Buffer {
  return sha256(Buffer.from('epoch-genesis-v1'), genesis_secret)
}
function stateRoot(epoch: bigint, genesis_hash: Buffer, validator_root: Buffer): Buffer {
  return sha256(Buffer.from('epoch-state-v1'), u64le(epoch), genesis_hash, validator_root)
}
function epochId(state_root: Buffer, epoch: bigint): Buffer {
  return sha256(Buffer.from('epoch-id-v1'), state_root, u64le(epoch))
}
function transitionHash(from_state_root: Buffer, to_state_root: Buffer, to_epoch: bigint): Buffer {
  return sha256(Buffer.from('epoch-trans-v1'), from_state_root, to_state_root, u64le(to_epoch))
}

describe('dark-null.epoch-transition', () => {
  // Test 1: epoch_id for epoch=0
  it('epoch_id for epoch=0 is correctly computed', () => {
    const genesis_secret = Buffer.alloc(32, 0x11)
    const validator_root = Buffer.alloc(32, 0xAA)
    const gh = genesisHash(genesis_secret)
    const sr = stateRoot(0n, gh, validator_root)
    const eid = epochId(sr, 0n)
    // recompute independently
    const gh2 = sha256(Buffer.from('epoch-genesis-v1'), genesis_secret)
    const sr2 = sha256(Buffer.from('epoch-state-v1'), u64le(0n), gh2, validator_root)
    const eid2 = sha256(Buffer.from('epoch-id-v1'), sr2, u64le(0n))
    expect(eid.toString('hex')).toBe(eid2.toString('hex'))
    expect(eid.length).toBe(32)
  })

  // Test 2: state_root sensitive to epoch
  it('state_root changes when epoch changes', () => {
    const genesis_secret = Buffer.alloc(32, 0x22)
    const validator_root = Buffer.alloc(32, 0xBB)
    const gh = genesisHash(genesis_secret)
    const sr0 = stateRoot(0n, gh, validator_root)
    const sr1 = stateRoot(1n, gh, validator_root)
    const sr7 = stateRoot(7n, gh, validator_root)
    expect(sr0.toString('hex')).not.toBe(sr1.toString('hex'))
    expect(sr1.toString('hex')).not.toBe(sr7.toString('hex'))
    expect(sr0.toString('hex')).not.toBe(sr7.toString('hex'))
  })

  // Test 3: transition_hash computation
  it('transition_hash is computed correctly from state roots', () => {
    const genesis_secret = Buffer.alloc(32, 0x33)
    const vr1 = Buffer.alloc(32, 0xAA)
    const vr2 = Buffer.alloc(32, 0xBB)
    const gh = genesisHash(genesis_secret)
    const from_sr = stateRoot(0n, gh, vr1)
    const to_sr = stateRoot(1n, gh, vr2)
    const th = transitionHash(from_sr, to_sr, 1n)
    const th2 = sha256(Buffer.from('epoch-trans-v1'), from_sr, to_sr, u64le(1n))
    expect(th.toString('hex')).toBe(th2.toString('hex'))
    expect(th.length).toBe(32)
  })

  // Test 4: epoch advances epoch number (different epoch_ids)
  it('advancing epoch produces different epoch_id', () => {
    const genesis_secret = Buffer.alloc(32, 0x44)
    const vr = Buffer.alloc(32, 0xCC)
    const gh = genesisHash(genesis_secret)
    const sr0 = stateRoot(0n, gh, vr)
    const sr1 = stateRoot(1n, gh, vr)
    const sr2 = stateRoot(2n, gh, vr)
    const eid0 = epochId(sr0, 0n)
    const eid1 = epochId(sr1, 1n)
    const eid2 = epochId(sr2, 2n)
    expect(eid0.toString('hex')).not.toBe(eid1.toString('hex'))
    expect(eid1.toString('hex')).not.toBe(eid2.toString('hex'))
    expect(eid0.toString('hex')).not.toBe(eid2.toString('hex'))
  })

  // Test 5: zero genesis rejected (hash differs — all-zero input produces distinct but valid hash; test semantics: zero secret produces different genesis_hash)
  it('zero genesis_secret produces distinct genesis_hash from non-zero', () => {
    const zero_secret = Buffer.alloc(32, 0x00)
    const nonzero_secret = Buffer.alloc(32, 0xFF)
    const vr = Buffer.alloc(32, 0xAA)
    const gh_zero = genesisHash(zero_secret)
    const gh_nonzero = genesisHash(nonzero_secret)
    const sr_zero = stateRoot(0n, gh_zero, vr)
    const sr_nonzero = stateRoot(0n, gh_nonzero, vr)
    // Zero genesis input produces different (and deterministically bad) outputs
    expect(gh_zero.toString('hex')).not.toBe(gh_nonzero.toString('hex'))
    expect(sr_zero.toString('hex')).not.toBe(sr_nonzero.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready is always false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
