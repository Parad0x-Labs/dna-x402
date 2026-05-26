import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u8(n: number): Buffer {
  return Buffer.from([n])
}

// ---------------------------------------------------------------------------
// Primitives matching crates/dark-relay-proof/src/lib.rs
// ---------------------------------------------------------------------------

const MAX_RELAY_HOPS = 10

function node_pubkey(node_secret: Buffer): Buffer {
  return sha256(Buffer.from('relay-node-v1'), node_secret)
}

function message_hash(message_bytes: Buffer): Buffer {
  return sha256(Buffer.from('relay-msg-v1'), message_bytes)
}

function attestation(
  pubkey: Buffer,
  msg_hash: Buffer,
  prev_hash: Buffer,
  hop: number,
): Buffer {
  return sha256(
    Buffer.from('relay-attest-v1'),
    pubkey,
    msg_hash,
    prev_hash,
    u8(hop),
  )
}

function xor_buffers(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i]
  return out
}

function chain_proof(xor_accumulator: Buffer): Buffer {
  return sha256(Buffer.from('relay-chain-v1'), xor_accumulator)
}

interface HopRecord {
  hop: number
  attestation_hash: Buffer
}

interface RelayChain {
  message_bytes: Buffer
  hops: HopRecord[]
  xor_acc: Buffer
  chain_proof: Buffer
  hop_count: number
}

type RelayError = 'EmptyMessage' | 'MaxHopsExceeded' | 'InvalidAttestation'

function build_relay_chain(
  node_secrets: Buffer[],
  message_bytes: Buffer,
): RelayChain | { error: RelayError } {
  if (message_bytes.length === 0) return { error: 'EmptyMessage' }
  if (node_secrets.length > MAX_RELAY_HOPS) return { error: 'MaxHopsExceeded' }

  const msg_hash = message_hash(message_bytes)
  let prev_hash = Buffer.alloc(32, 0)
  let xor_acc = Buffer.alloc(32, 0)
  const hops: HopRecord[] = []

  for (let i = 0; i < node_secrets.length; i++) {
    const pubkey = node_pubkey(node_secrets[i])
    const attest = attestation(pubkey, msg_hash, prev_hash, i)
    xor_acc = xor_buffers(xor_acc, attest)
    hops.push({ hop: i, attestation_hash: attest })
    prev_hash = attest
  }

  const cp = chain_proof(xor_acc)
  return { message_bytes, hops, xor_acc, chain_proof: cp, hop_count: hops.length }
}

function verify_attestation_at(
  node_secret: Buffer,
  message_bytes: Buffer,
  prev_hash: Buffer,
  hop: number,
  expected: Buffer,
): boolean {
  const pubkey = node_pubkey(node_secret)
  const msg_hash = message_hash(message_bytes)
  const computed = attestation(pubkey, msg_hash, prev_hash, hop)
  return computed.equals(expected)
}

function public_record(chain: RelayChain): {
  chain_proof_hex: string
  hop_count: number
} {
  return {
    chain_proof_hex: chain.chain_proof.toString('hex'),
    hop_count: chain.hop_count,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const MSG = Buffer.from('relay-message-payload')
const SECRETS = [
  Buffer.from('node-secret-0'),
  Buffer.from('node-secret-1'),
  Buffer.from('node-secret-2'),
]

describe('dark-relay-proof', () => {
  it('3-hop relay chain: all attestations valid, chain_proof builds', () => {
    const result = build_relay_chain(SECRETS, MSG)
    expect('error' in result).toBe(false)
    const chain = result as RelayChain

    expect(chain.hop_count).toBe(3)
    expect(chain.hops).toHaveLength(3)
    expect(chain.chain_proof).toHaveLength(32)

    // Verify each attestation independently
    let prev = Buffer.alloc(32, 0)
    for (let i = 0; i < SECRETS.length; i++) {
      const valid = verify_attestation_at(
        SECRETS[i],
        MSG,
        prev,
        i,
        chain.hops[i].attestation_hash,
      )
      expect(valid).toBe(true)
      prev = chain.hops[i].attestation_hash
    }

    // Recompute xor accumulator and chain_proof
    let xor_acc = Buffer.alloc(32, 0)
    for (const hop of chain.hops) {
      xor_acc = xor_buffers(xor_acc, hop.attestation_hash)
    }
    const expected_cp = chain_proof(xor_acc)
    expect(expected_cp.equals(chain.chain_proof)).toBe(true)
  })

  it('empty message: detect (0-length check)', () => {
    const result = build_relay_chain(SECRETS, Buffer.alloc(0))
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('EmptyMessage')
  })

  it('max hops: hop=10 rejected (MAX_RELAY_HOPS=10)', () => {
    // Exactly MAX_RELAY_HOPS nodes is the limit — 11 must be rejected
    const eleven_secrets = Array.from({ length: 11 }, (_, i) =>
      Buffer.from(`node-secret-${i}`),
    )
    const result = build_relay_chain(eleven_secrets, MSG)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('MaxHopsExceeded')

    // Exactly 10 hops must succeed
    const ten_secrets = Array.from({ length: 10 }, (_, i) =>
      Buffer.from(`node-secret-${i}`),
    )
    const ok = build_relay_chain(ten_secrets, MSG)
    expect('error' in ok).toBe(false)
    if (!('error' in ok)) expect((ok as RelayChain).hop_count).toBe(10)
  })

  it('verify_attestation: recompute hash and confirm', () => {
    const result = build_relay_chain(SECRETS, MSG)
    const chain = result as RelayChain

    // Hop 0: prev_hash is the zero buffer
    const valid = verify_attestation_at(
      SECRETS[0],
      MSG,
      Buffer.alloc(32, 0),
      0,
      chain.hops[0].attestation_hash,
    )
    expect(valid).toBe(true)

    // Wrong secret → false
    const wrong = verify_attestation_at(
      Buffer.from('wrong-secret'),
      MSG,
      Buffer.alloc(32, 0),
      0,
      chain.hops[0].attestation_hash,
    )
    expect(wrong).toBe(false)
  })

  it('chain_proof changes on every hop', () => {
    const proofs: string[] = []

    for (let n = 1; n <= 3; n++) {
      const secrets = SECRETS.slice(0, n)
      const result = build_relay_chain(secrets, MSG)
      const chain = result as RelayChain
      proofs.push(chain.chain_proof.toString('hex'))
    }

    // All three chain_proofs must be distinct
    const unique = new Set(proofs)
    expect(unique.size).toBe(3)
  })

  it('public record: chain_proof_hex + hop_count; no node pubkeys', () => {
    const result = build_relay_chain(SECRETS, MSG)
    const chain = result as RelayChain

    const rec = public_record(chain)
    expect(typeof rec.chain_proof_hex).toBe('string')
    expect(rec.chain_proof_hex).toHaveLength(64) // 32 bytes as hex
    expect(rec.hop_count).toBe(3)

    const recStr = JSON.stringify(rec)
    // Node pubkeys and secrets must not appear
    for (const s of SECRETS) {
      expect(recStr).not.toContain(s.toString('hex'))
      expect(recStr).not.toContain(node_pubkey(s).toString('hex'))
    }
    expect(recStr).not.toContain('attestation_hash')
    expect(recStr).not.toContain('hops')
    expect(recStr).not.toContain('xor_acc')
  })
})
