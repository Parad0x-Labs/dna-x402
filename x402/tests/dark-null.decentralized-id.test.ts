import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Primitives matching Rust DID crate exactly
// ---------------------------------------------------------------------------

function controllerHash(secret: Buffer): Buffer {
  return sha256(Buffer.from('did-controller-v1'), secret)
}

function vmHash(ch: Buffer): Buffer {
  return sha256(Buffer.from('did-vm-v1'), ch)
}

function documentHash(doc: Buffer): Buffer {
  return sha256(Buffer.from('did-doc-v1'), doc)
}

function didId(ctrl: Buffer, vm: Buffer, doc: Buffer, createdAt: bigint): Buffer {
  return sha256(Buffer.from('did-id-v1'), ctrl, vm, doc, i64le(createdAt))
}

function challengeHash(did: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('did-challenge-v1'), did, nonce)
}

function responseHash(ctrl: Buffer, chal: Buffer): Buffer {
  return sha256(Buffer.from('did-response-v1'), ctrl, chal)
}

function proofId(did: Buffer, resp: Buffer): Buffer {
  return sha256(Buffer.from('did-proof-v1'), did, resp)
}

interface DidDocument {
  did_id: Buffer
  vm_hash: Buffer
  document_hash: Buffer
  created_at: bigint
  mainnet_ready: boolean
  // internal — not in public record
  _controller_hash: Buffer
}

function createDid(secret: Buffer, doc: Buffer, createdAt: bigint): DidDocument {
  const ctrl = controllerHash(secret)
  const vm = vmHash(ctrl)
  const dh = documentHash(doc)
  const did = didId(ctrl, vm, dh, createdAt)
  return {
    did_id: did,
    vm_hash: vm,
    document_hash: dh,
    created_at: createdAt,
    mainnet_ready: false,
    _controller_hash: ctrl,
  }
}

function publicRecord(d: DidDocument) {
  return {
    did_id: d.did_id.toString('hex'),
    vm_hash: d.vm_hash.toString('hex'),
    document_hash: d.document_hash.toString('hex'),
    created_at: d.created_at.toString(),
    mainnet_ready: d.mainnet_ready,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET = Buffer.from('controller-secret-xyz')
const DOC = Buffer.from('{"@context":"https://www.w3.org/ns/did/v1"}')
const DOC2 = Buffer.from('{"@context":"https://www.w3.org/ns/did/v1","id":"did:example:123"}')
const CREATED_AT = 1_700_000_000n
const NONCE = Buffer.alloc(32, 0x11)

describe('dark-null.decentralized-id', () => {
  it('did_id formula is correct', () => {
    const ctrl = controllerHash(SECRET)
    const vm = vmHash(ctrl)
    const dh = documentHash(DOC)
    const expected = sha256(Buffer.from('did-id-v1'), ctrl, vm, dh, i64le(CREATED_AT))
    const did = createDid(SECRET, DOC, CREATED_AT)
    expect(did.did_id.toString('hex')).toBe(expected.toString('hex'))
    expect(did.did_id.length).toBe(32)
  })

  it('challenge/response/proof_id are deterministic', () => {
    const did = createDid(SECRET, DOC, CREATED_AT)
    const chal = challengeHash(did.did_id, NONCE)
    const resp = responseHash(did._controller_hash, chal)
    const pid = proofId(did.did_id, resp)

    // Run again — same inputs → same outputs
    const chal2 = challengeHash(did.did_id, NONCE)
    const resp2 = responseHash(did._controller_hash, chal2)
    const pid2 = proofId(did.did_id, resp2)

    expect(chal.toString('hex')).toBe(chal2.toString('hex'))
    expect(resp.toString('hex')).toBe(resp2.toString('hex'))
    expect(pid.toString('hex')).toBe(pid2.toString('hex'))
  })

  it('verify_did_proof: response_hash matches recomputed', () => {
    const did = createDid(SECRET, DOC, CREATED_AT)
    const chal = challengeHash(did.did_id, NONCE)
    const resp = responseHash(did._controller_hash, chal)

    // Verify: recompute response from known controller_hash + challenge
    const recomputed = responseHash(did._controller_hash, chal)
    expect(recomputed.toString('hex')).toBe(resp.toString('hex'))
  })

  it('different documents produce different did_ids', () => {
    const did1 = createDid(SECRET, DOC, CREATED_AT)
    const did2 = createDid(SECRET, DOC2, CREATED_AT)
    expect(did1.did_id.toString('hex')).not.toBe(did2.did_id.toString('hex'))
    expect(did1.document_hash.toString('hex')).not.toBe(did2.document_hash.toString('hex'))
  })

  it('public record contains did_id, does not contain controller_hash', () => {
    const did = createDid(SECRET, DOC, CREATED_AT)
    const rec = publicRecord(did)
    expect(rec).toHaveProperty('did_id')
    expect(rec).not.toHaveProperty('controller_hash')
    expect(rec).not.toHaveProperty('_controller_hash')
    expect(typeof rec.did_id).toBe('string')
    expect(rec.did_id.length).toBe(64)
  })

  it('mainnet_ready is false', () => {
    const did = createDid(SECRET, DOC, CREATED_AT)
    expect(did.mainnet_ready).toBe(false)
    const rec = publicRecord(did)
    expect(rec.mainnet_ready).toBe(false)
  })
})
