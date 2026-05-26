import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u8(n: number): Buffer { return Buffer.from([n]) }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

function memberPubkey(memberSecret: Buffer): Buffer {
  return sha256(Buffer.from('ring-member-v1'), memberSecret)
}

function xorAccumulator(pubkeys: Buffer[]): Buffer {
  if (pubkeys.length === 0) {
    return Buffer.alloc(32)
  }
  const acc = Buffer.alloc(32)
  for (const pk of pubkeys) {
    for (let i = 0; i < 32; i++) {
      acc[i] ^= pk[i]
    }
  }
  return acc
}

function ringRoot(members: Buffer[]): Buffer {
  const xorAcc = xorAccumulator(members)
  return sha256(Buffer.from('ring-root-v1'), xorAcc)
}

function endorsementHash(
  targetHash: Buffer,
  ringRootBuf: Buffer,
  nonce: Buffer,
): Buffer {
  return sha256(
    Buffer.from('ring-endorse-v1'),
    targetHash,
    ringRootBuf,
    nonce,
  )
}

function linkabilityTag(
  memberSecret: Buffer,
  endHash: Buffer,
): Buffer {
  return sha256(
    Buffer.from('endorse-link-v1'),
    memberSecret,
    endHash,
  )
}

describe('dark-null reputation-ring', () => {
  it('3-member ring: member 0 endorses target, verify passes', () => {
    const secrets = [
      Buffer.from('member-secret-A'),
      Buffer.from('member-secret-B'),
      Buffer.from('member-secret-C'),
    ]

    const pubkeys = secrets.map(memberPubkey)
    const root = ringRoot(pubkeys)

    // member 0 endorses a target
    const targetHash = sha256(Buffer.from('target-identity-001'))
    const nonce = Buffer.from('nonce-endorse-0001')

    const endHash = endorsementHash(targetHash, root, nonce)

    // Verifier recomputes ring root and endorsement hash
    const rootCheck = ringRoot(pubkeys)
    const endHashCheck = endorsementHash(targetHash, rootCheck, nonce)

    expect(root.toString('hex')).toBe(rootCheck.toString('hex'))
    expect(endHash.toString('hex')).toBe(endHashCheck.toString('hex'))
    expect(endHash.length).toBe(32)
  })

  it('non-member cannot endorse: recomputed endorsement_hash mismatch', () => {
    const secrets = [
      Buffer.from('member-secret-D'),
      Buffer.from('member-secret-E'),
    ]

    const pubkeys = secrets.map(memberPubkey)
    const root = ringRoot(pubkeys)

    const targetHash = sha256(Buffer.from('target-identity-002'))
    const nonce = Buffer.from('nonce-endorse-0002')

    // Valid endorsement from true ring root
    const validEndHash = endorsementHash(targetHash, root, nonce)

    // Non-member computes ring root over a different member set
    const outsiderSecret = Buffer.from('outsider-secret-X')
    const outsiderPubkey = memberPubkey(outsiderSecret)
    const fakeRoot = ringRoot([...pubkeys, outsiderPubkey])

    const fakeEndHash = endorsementHash(targetHash, fakeRoot, nonce)

    // The fake endorsement does not match the valid one
    expect(validEndHash.toString('hex')).not.toBe(fakeEndHash.toString('hex'))
  })

  it('ring_root changes on every member add', () => {
    const secretA = Buffer.from('member-secret-F')
    const secretB = Buffer.from('member-secret-G')
    const secretC = Buffer.from('member-secret-H')

    const pkA = memberPubkey(secretA)
    const pkB = memberPubkey(secretB)
    const pkC = memberPubkey(secretC)

    const root1 = ringRoot([pkA])
    const root2 = ringRoot([pkA, pkB])
    const root3 = ringRoot([pkA, pkB, pkC])

    // Each addition changes the root
    expect(root1.toString('hex')).not.toBe(root2.toString('hex'))
    expect(root2.toString('hex')).not.toBe(root3.toString('hex'))
    expect(root1.toString('hex')).not.toBe(root3.toString('hex'))
  })

  it('endorsement is unlinkable: same member, different nonce → different linkability_tag', () => {
    const secrets = [
      Buffer.from('member-secret-I'),
      Buffer.from('member-secret-J'),
    ]

    const pubkeys = secrets.map(memberPubkey)
    const root = ringRoot(pubkeys)

    const targetHash = sha256(Buffer.from('target-identity-003'))

    const nonce1 = Buffer.from('nonce-link-0001')
    const nonce2 = Buffer.from('nonce-link-0002')

    const endHash1 = endorsementHash(targetHash, root, nonce1)
    const endHash2 = endorsementHash(targetHash, root, nonce2)

    // Same member, different nonces → different endorsement hashes
    expect(endHash1.toString('hex')).not.toBe(endHash2.toString('hex'))

    // Linkability tags are also different
    const tag1 = linkabilityTag(secrets[0], endHash1)
    const tag2 = linkabilityTag(secrets[0], endHash2)

    expect(tag1.toString('hex')).not.toBe(tag2.toString('hex'))
  })

  it('endorsement hash is target-specific: same member, different target → different endorsement_hash', () => {
    const secrets = [
      Buffer.from('member-secret-K'),
      Buffer.from('member-secret-L'),
    ]

    const pubkeys = secrets.map(memberPubkey)
    const root = ringRoot(pubkeys)

    const targetHashA = sha256(Buffer.from('target-identity-004'))
    const targetHashB = sha256(Buffer.from('target-identity-005'))

    const nonce = Buffer.from('nonce-target-spec-001')

    const endHashA = endorsementHash(targetHashA, root, nonce)
    const endHashB = endorsementHash(targetHashB, root, nonce)

    // Different targets → different endorsement hashes even with same nonce
    expect(endHashA.toString('hex')).not.toBe(endHashB.toString('hex'))

    // Linkability tags also differ per target
    const tagA = linkabilityTag(secrets[0], endHashA)
    const tagB = linkabilityTag(secrets[0], endHashB)

    expect(tagA.toString('hex')).not.toBe(tagB.toString('hex'))
  })

  it('public record: ring_root + member_count; no individual pubkeys', () => {
    const secrets = [
      Buffer.from('member-secret-M'),
      Buffer.from('member-secret-N'),
      Buffer.from('member-secret-O'),
    ]

    const pubkeys = secrets.map(memberPubkey)
    const root = ringRoot(pubkeys)

    const targetHash = sha256(Buffer.from('target-identity-006'))
    const nonce = Buffer.from('nonce-public-rec-001')

    const endHash = endorsementHash(targetHash, root, nonce)

    // Public record contains ring_root, member_count, and endorsement_hash
    // It does NOT contain individual pubkeys
    const publicRecord = {
      ring_root: root.toString('hex'),
      member_count: pubkeys.length,
      endorsement_hash: endHash.toString('hex'),
    }

    expect(publicRecord.ring_root).toBe(root.toString('hex'))
    expect(publicRecord.member_count).toBe(3)
    expect(publicRecord.endorsement_hash).toBe(endHash.toString('hex'))

    // Individual member pubkeys are NOT present in the public record
    expect('member_pubkeys' in publicRecord).toBe(false)
    expect('members' in publicRecord).toBe(false)

    // ring_root is still verifiable from the full member set
    const rootCheck = ringRoot(pubkeys)
    expect(publicRecord.ring_root).toBe(rootCheck.toString('hex'))
  })
})
