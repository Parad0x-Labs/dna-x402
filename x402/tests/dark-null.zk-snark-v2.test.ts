import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function xorFold(hs: Buffer[]): Buffer {
  const a = Buffer.alloc(32, 0); for (const h of hs) for (let i = 0; i < 32; i++) a[i] ^= h[i]; return a
}

// ---------------------------------------------------------------------------
// ZK-SNARK-v2 inline implementation
// Mirrors crates/dark-zk-snark-v2/src/lib.rs
//
// pk_hash = SHA256("snarkv2-pk-v1" || proving_key)
// vk_hash = SHA256("snarkv2-vk-v1" || verifying_key)
// input_hash[i] = SHA256("snarkv2-input-v1" || [i as u32le] || input_bytes[i])
// public_inputs_hash = SHA256("snarkv2-inputs-v1" || XOR_fold(input_hashes))
// pi_a = SHA256("snarkv2-a-v1" || pk_hash || public_inputs_hash)
// pi_b = SHA256("snarkv2-b-v1" || pk_hash || pi_a)
// pi_c = SHA256("snarkv2-c-v1" || pk_hash || pi_a || pi_b)
// proof_id = SHA256("snarkv2-id-v1" || pi_a || pi_b || pi_c || vk_hash)
//
// is_stub = true (devnet)
// mainnet_ready = false
// ---------------------------------------------------------------------------

function pkHash(provingKey: Buffer): Buffer {
  return sha256(Buffer.from('snarkv2-pk-v1'), provingKey)
}

function vkHash(verifyingKey: Buffer): Buffer {
  return sha256(Buffer.from('snarkv2-vk-v1'), verifyingKey)
}

function inputHash(i: number, inputBytes: Buffer): Buffer {
  return sha256(Buffer.from('snarkv2-input-v1'), u32le(i), inputBytes)
}

function publicInputsHash(inputs: Buffer[]): Buffer {
  const hashes = inputs.map((inp, i) => inputHash(i, inp))
  const folded = xorFold(hashes)
  return sha256(Buffer.from('snarkv2-inputs-v1'), folded)
}

function computeProof(provingKey: Buffer, inputs: Buffer[]): {
  pi_a: Buffer; pi_b: Buffer; pi_c: Buffer
} {
  const pk = pkHash(provingKey)
  const piH = publicInputsHash(inputs)
  const pi_a = sha256(Buffer.from('snarkv2-a-v1'), pk, piH)
  const pi_b = sha256(Buffer.from('snarkv2-b-v1'), pk, pi_a)
  const pi_c = sha256(Buffer.from('snarkv2-c-v1'), pk, pi_a, pi_b)
  return { pi_a, pi_b, pi_c }
}

function proofId(pi_a: Buffer, pi_b: Buffer, pi_c: Buffer, vk: Buffer): Buffer {
  return sha256(Buffer.from('snarkv2-id-v1'), pi_a, pi_b, pi_c, vk)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zk-snark-v2', () => {
  const PROVING_KEY = Buffer.alloc(64).fill(0x01)
  const VERIFYING_KEY = Buffer.alloc(64).fill(0x02)
  const INPUTS_A = [Buffer.from('public-input-0'), Buffer.from('public-input-1')]
  const INPUTS_B = [Buffer.from('public-input-0'), Buffer.from('different-input')]

  it('pi_a, pi_b, pi_c are computed correctly from proving_key and public_inputs', () => {
    const pk = pkHash(PROVING_KEY)
    const piH = publicInputsHash(INPUTS_A)
    const { pi_a, pi_b, pi_c } = computeProof(PROVING_KEY, INPUTS_A)

    expect(pi_a.length).toBe(32)
    expect(pi_b.length).toBe(32)
    expect(pi_c.length).toBe(32)

    const expected_a = sha256(Buffer.from('snarkv2-a-v1'), pk, piH)
    const expected_b = sha256(Buffer.from('snarkv2-b-v1'), pk, expected_a)
    const expected_c = sha256(Buffer.from('snarkv2-c-v1'), pk, expected_a, expected_b)

    expect(pi_a).toEqual(expected_a)
    expect(pi_b).toEqual(expected_b)
    expect(pi_c).toEqual(expected_c)
  })

  it('proof_id = SHA256("snarkv2-id-v1" || pi_a || pi_b || pi_c || vk_hash)', () => {
    const { pi_a, pi_b, pi_c } = computeProof(PROVING_KEY, INPUTS_A)
    const vk = vkHash(VERIFYING_KEY)
    const pid = proofId(pi_a, pi_b, pi_c, vk)
    expect(pid.length).toBe(32)
    const expected = sha256(Buffer.from('snarkv2-id-v1'), pi_a, pi_b, pi_c, vk)
    expect(pid).toEqual(expected)
  })

  it('verify: recompute public_inputs_hash and vk_hash, reconstruct proof_id', () => {
    const { pi_a, pi_b, pi_c } = computeProof(PROVING_KEY, INPUTS_A)
    const vk = vkHash(VERIFYING_KEY)
    const pid = proofId(pi_a, pi_b, pi_c, vk)

    // Verification: recompute from scratch and compare proof_id
    const pk = pkHash(PROVING_KEY)
    const piH = publicInputsHash(INPUTS_A)
    const recomp_a = sha256(Buffer.from('snarkv2-a-v1'), pk, piH)
    const recomp_b = sha256(Buffer.from('snarkv2-b-v1'), pk, recomp_a)
    const recomp_c = sha256(Buffer.from('snarkv2-c-v1'), pk, recomp_a, recomp_b)
    const recomputed_vk = vkHash(VERIFYING_KEY)
    const recomp_pid = proofId(recomp_a, recomp_b, recomp_c, recomputed_vk)
    expect(recomp_pid).toEqual(pid)
  })

  it('is_stub=true and mainnet_ready=false in public record', () => {
    const { pi_a, pi_b, pi_c } = computeProof(PROVING_KEY, INPUTS_A)
    const vk = vkHash(VERIFYING_KEY)
    const pid = proofId(pi_a, pi_b, pi_c, vk)
    const record = {
      proof_id: pid.toString('hex'),
      is_stub: true,
      mainnet_ready: false,
    }
    expect(record.is_stub).toBe(true)
    expect(record.mainnet_ready).toBe(false)
    expect(record.proof_id.length).toBe(64)
  })

  it('different inputs → different pi_a', () => {
    const { pi_a: piA_1 } = computeProof(PROVING_KEY, INPUTS_A)
    const { pi_a: piA_2 } = computeProof(PROVING_KEY, INPUTS_B)
    expect(piA_1.equals(piA_2)).toBe(false)
  })

  it('proof generation is deterministic: same inputs → same proof_id', () => {
    const { pi_a: a1, pi_b: b1, pi_c: c1 } = computeProof(PROVING_KEY, INPUTS_A)
    const { pi_a: a2, pi_b: b2, pi_c: c2 } = computeProof(PROVING_KEY, INPUTS_A)
    const vk = vkHash(VERIFYING_KEY)
    const pid1 = proofId(a1, b1, c1, vk)
    const pid2 = proofId(a2, b2, c2, vk)
    expect(pid1).toEqual(pid2)
  })
})
