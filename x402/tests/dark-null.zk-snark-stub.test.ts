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
function u8(n: number): Buffer { return Buffer.from([n]) }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// ---------------------------------------------------------------------------
// ZkSnarkStub (mirrors crates/dark-zk-snark-stub/src/lib.rs)
//
// For each public_input:
//   input_elem_hash  = SHA256("snark-input-v1" || input_bytes)
//
// public_inputs_hash = SHA256("snark-inputs-v1" || XOR-fold(all input_elem_hashes))
//   XOR-fold: start with 32-byte zero buffer, XOR each input_elem_hash in order
//
// proof_hash = SHA256("snark-proof-v1" || circuit_id[32] || public_inputs_hash[32])
//
// is_stub = true always in devnet mode
//
// Errors: EmptyInputs, ZeroCircuitId
// ---------------------------------------------------------------------------

const ZERO_32 = Buffer.alloc(32, 0)

function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) {
    for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  }
  return acc
}

function inputElemHash(input_bytes: Buffer): Buffer {
  return sha256(Buffer.from('snark-input-v1'), input_bytes)
}

function publicInputsHash(inputs: Buffer[]): Buffer {
  if (inputs.length === 0) throw new Error('EmptyInputs')
  const elem_hashes = inputs.map(inputElemHash)
  const folded      = xorFold(elem_hashes)
  return sha256(Buffer.from('snark-inputs-v1'), folded)
}

interface SnarkStatement {
  circuit_id: Buffer          // 32 bytes
  public_inputs_hash: Buffer  // 32 bytes
  proof_hash: Buffer          // 32 bytes
  is_stub: boolean            // always true in devnet
}

function createStatement(circuit_id: Buffer, inputs: Buffer[]): SnarkStatement {
  if (circuit_id.equals(ZERO_32)) throw new Error('ZeroCircuitId')
  if (inputs.length === 0) throw new Error('EmptyInputs')

  const pi_hash    = publicInputsHash(inputs)
  const p_hash     = sha256(Buffer.from('snark-proof-v1'), circuit_id, pi_hash)

  return {
    circuit_id:         Buffer.from(circuit_id),
    public_inputs_hash: pi_hash,
    proof_hash:         p_hash,
    is_stub:            true,
  }
}

function verifyStub(stmt: SnarkStatement, circuit_id: Buffer, inputs: Buffer[]): boolean {
  if (inputs.length === 0) return false
  if (circuit_id.equals(ZERO_32)) return false

  const pi_hash = publicInputsHash(inputs)
  const p_hash  = sha256(Buffer.from('snark-proof-v1'), circuit_id, pi_hash)

  return p_hash.equals(stmt.proof_hash) && pi_hash.equals(stmt.public_inputs_hash)
}

function publicRecord(stmt: SnarkStatement): object {
  return {
    proof_hash:  stmt.proof_hash.toString('hex'),
    is_stub:     stmt.is_stub,
    circuit_id:  stmt.circuit_id.toString('hex'),
    // public_inputs_hash exposed for auditability (it hides individual input values)
    public_inputs_hash: stmt.public_inputs_hash.toString('hex'),
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null zk-snark-stub', () => {
  const CIRCUIT_ID = Buffer.alloc(32).fill(0xc1)
  const INPUTS_A   = [Buffer.from('witness-0'), Buffer.from('witness-1')]
  const INPUTS_B   = [Buffer.from('witness-0'), Buffer.from('different')]

  it('create statement + generate proof + verify passes', () => {
    const stmt = createStatement(CIRCUIT_ID, INPUTS_A)
    expect(stmt.proof_hash.length).toBe(32)
    expect(stmt.is_stub).toBe(true)
    expect(verifyStub(stmt, CIRCUIT_ID, INPUTS_A)).toBe(true)
  })

  it('empty inputs are rejected', () => {
    expect(() => createStatement(CIRCUIT_ID, [])).toThrow('EmptyInputs')
    expect(() => publicInputsHash([])).toThrow('EmptyInputs')
  })

  it('zero circuit_id is rejected', () => {
    expect(() => createStatement(ZERO_32, INPUTS_A)).toThrow('ZeroCircuitId')
  })

  it('proof_hash is deterministic for the same inputs', () => {
    const s1 = createStatement(CIRCUIT_ID, INPUTS_A)
    const s2 = createStatement(CIRCUIT_ID, INPUTS_A)
    expect(s1.proof_hash.equals(s2.proof_hash)).toBe(true)
    expect(s1.public_inputs_hash.equals(s2.public_inputs_hash)).toBe(true)
  })

  it('different inputs produce different public_inputs_hash', () => {
    const s1 = createStatement(CIRCUIT_ID, INPUTS_A)
    const s2 = createStatement(CIRCUIT_ID, INPUTS_B)
    expect(s1.public_inputs_hash.equals(s2.public_inputs_hash)).toBe(false)
    expect(s1.proof_hash.equals(s2.proof_hash)).toBe(false)
  })

  it('public record has proof_hash hex + is_stub=true + circuit_id hex, mainnet_ready false', () => {
    const stmt = createStatement(CIRCUIT_ID, INPUTS_A)
    const rec  = publicRecord(stmt) as Record<string, unknown>

    expect(rec['proof_hash']).toBe(stmt.proof_hash.toString('hex'))
    expect(rec['is_stub']).toBe(true)
    expect(rec['circuit_id']).toBe(CIRCUIT_ID.toString('hex'))
    expect(rec['mainnet_ready']).toBe(false)
  })
})
