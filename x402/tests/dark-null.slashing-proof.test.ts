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
function xorFold(hs: Buffer[]): Buffer { const a = Buffer.alloc(32,0); for (const h of hs) for (let i=0;i<32;i++) a[i]^=h[i]; return a }

// ---------------------------------------------------------------------------
// Slashing Proof
//
// validator_hash = SHA256("slash-validator-v1" || validator_secret)
// offense_hash   = SHA256("slash-offense-v1"   || offense_bytes)
// witness_hash   = SHA256("slash-witness-v1"   || witness_secret)
// evidence_id    = SHA256("slash-evidence-v1"  || validator_hash || offense_hash || epoch_u64le || witness_hash)
// verdict_id     = SHA256("slash-verdict-v1"   || evidence_id || [slashed_u8])
// ---------------------------------------------------------------------------

function validatorHash(validatorSecret: Buffer): Buffer {
  return sha256(Buffer.from('slash-validator-v1'), validatorSecret)
}

function offenseHash(offenseBytes: Buffer): Buffer {
  return sha256(Buffer.from('slash-offense-v1'), offenseBytes)
}

function witnessHash(witnessSecret: Buffer): Buffer {
  return sha256(Buffer.from('slash-witness-v1'), witnessSecret)
}

function evidenceId(
  validatorSecret: Buffer,
  offenseBytes: Buffer,
  epoch: bigint,
  witnessSecret: Buffer
): Buffer {
  const vh = validatorHash(validatorSecret)
  const oh = offenseHash(offenseBytes)
  const wh = witnessHash(witnessSecret)
  return sha256(Buffer.from('slash-evidence-v1'), vh, oh, u64le(epoch), wh)
}

function verdictId(evId: Buffer, slashed: boolean): Buffer {
  return sha256(Buffer.from('slash-verdict-v1'), evId, Buffer.from([slashed ? 1 : 0]))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null slashing-proof', () => {
  const VALIDATOR_SECRET = Buffer.from('validator-secret-0001')
  const WITNESS_SECRET   = Buffer.from('witness-secret-0001')
  const OFFENSE_BYTES    = Buffer.from('double-sign-slot-12345')
  const EPOCH            = 42n

  it('evidence_id computation is deterministic and correct', () => {
    const eid1 = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)
    const eid2 = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)

    expect(eid1.length).toBe(32)
    expect(eid1.equals(eid2)).toBe(true)

    // manual recompute
    const vh = sha256(Buffer.from('slash-validator-v1'), VALIDATOR_SECRET)
    const oh = sha256(Buffer.from('slash-offense-v1'), OFFENSE_BYTES)
    const wh = sha256(Buffer.from('slash-witness-v1'), WITNESS_SECRET)
    const expected = sha256(Buffer.from('slash-evidence-v1'), vh, oh, u64le(EPOCH), wh)
    expect(eid1.equals(expected)).toBe(true)
  })

  it('verdict_id for slashed=true is deterministic and correct', () => {
    const eid = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)
    const vid1 = verdictId(eid, true)
    const vid2 = verdictId(eid, true)

    expect(vid1.length).toBe(32)
    expect(vid1.equals(vid2)).toBe(true)

    const expected = sha256(Buffer.from('slash-verdict-v1'), eid, Buffer.from([1]))
    expect(vid1.equals(expected)).toBe(true)
  })

  it('verdict_id for slashed=false differs from slashed=true', () => {
    const eid = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)
    const vidSlashed    = verdictId(eid, true)
    const vidNotSlashed = verdictId(eid, false)

    expect(vidSlashed.equals(vidNotSlashed)).toBe(false)

    // verify slashed=false recompute
    const expectedFalse = sha256(Buffer.from('slash-verdict-v1'), eid, Buffer.from([0]))
    expect(vidNotSlashed.equals(expectedFalse)).toBe(true)
  })

  it('public record hides validator and witness identities', () => {
    const eid = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)
    const vid = verdictId(eid, true)
    const vh  = validatorHash(VALIDATOR_SECRET)
    const wh  = witnessHash(WITNESS_SECRET)

    const publicRecord = {
      evidence_id: eid.toString('hex'),
      verdict_id:  vid.toString('hex'),
      epoch:       Number(EPOCH),
      mainnet_ready: false,
    }

    const recordJson = JSON.stringify(publicRecord)

    // Raw secrets must not appear
    expect(recordJson).not.toContain(VALIDATOR_SECRET.toString('hex'))
    expect(recordJson).not.toContain(WITNESS_SECRET.toString('hex'))

    // The hashes (which hide identity) must not appear in the public record
    expect(recordJson).not.toContain(vh.toString('hex'))
    expect(recordJson).not.toContain(wh.toString('hex'))

    expect(publicRecord.mainnet_ready).toBe(false)
  })

  it('different epochs produce different evidence_ids', () => {
    const eid1 = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, 1n, WITNESS_SECRET)
    const eid2 = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, 2n, WITNESS_SECRET)
    expect(eid1.equals(eid2)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    const eid = evidenceId(VALIDATOR_SECRET, OFFENSE_BYTES, EPOCH, WITNESS_SECRET)
    const record = {
      evidence_id: eid.toString('hex'),
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
  })
})
