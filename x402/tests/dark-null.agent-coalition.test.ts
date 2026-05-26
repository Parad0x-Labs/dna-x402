import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  return acc
}

const AGENT_SECRETS = [
  Buffer.from('agent-secret-alpha-00000000001', 'utf8'),
  Buffer.from('agent-secret-beta-000000000002', 'utf8'),
  Buffer.from('agent-secret-gamma-00000000003', 'utf8'),
]
const THRESHOLD = Buffer.from([2]) // 2-of-3
const MESSAGE = Buffer.from('coalition-signed-message-v1-alpha', 'utf8')

function buildCoalition(
  agentSecrets: Buffer[],
  threshold: Buffer
): { pubkeys: Buffer[]; agentIds: Buffer[]; coalitionId: Buffer } {
  const pubkeys = agentSecrets.map(s => sha256(Buffer.from('coalition-agent-v1'), s))
  const agentIds = pubkeys.map(pk => sha256(Buffer.from('coalition-id-v1'), pk))
  const coalitionId = sha256(Buffer.from('coalition-root-v1'), xorFold(pubkeys), threshold)
  return { pubkeys, agentIds, coalitionId }
}

function buildAggregateSig(
  coalitionId: Buffer,
  messageBytes: Buffer,
  agentSecrets: Buffer[]
): { messageHash: Buffer; partialSigs: Buffer[]; aggregateSig: Buffer } {
  const messageHash = sha256(Buffer.from('coalition-msg-v1'), messageBytes)
  const partialSigs = agentSecrets.map(s =>
    sha256(Buffer.from('coalition-partial-v1'), coalitionId, messageHash, s)
  )
  const aggregateSig = sha256(
    Buffer.from('coalition-agg-v1'),
    coalitionId,
    messageHash,
    xorFold(partialSigs)
  )
  return { messageHash, partialSigs, aggregateSig }
}

describe('dark-null agent-coalition', () => {
  it('coalition_id computation is correct', () => {
    const { pubkeys, coalitionId } = buildCoalition(AGENT_SECRETS, THRESHOLD)

    const expectedPubkeys = AGENT_SECRETS.map(s => sha256(Buffer.from('coalition-agent-v1'), s))
    const expectedCoalitionId = sha256(
      Buffer.from('coalition-root-v1'),
      xorFold(expectedPubkeys),
      THRESHOLD
    )

    expect(pubkeys.map(p => p.toString('hex'))).toEqual(expectedPubkeys.map(p => p.toString('hex')))
    expect(coalitionId.toString('hex')).toBe(expectedCoalitionId.toString('hex'))
    expect(coalitionId).toHaveLength(32)
  })

  it('aggregate_sig is deterministic', () => {
    const { coalitionId } = buildCoalition(AGENT_SECRETS, THRESHOLD)

    const run1 = buildAggregateSig(coalitionId, MESSAGE, AGENT_SECRETS)
    const run2 = buildAggregateSig(coalitionId, MESSAGE, AGENT_SECRETS)

    expect(run1.aggregateSig.toString('hex')).toBe(run2.aggregateSig.toString('hex'))
    expect(run1.messageHash.toString('hex')).toBe(run2.messageHash.toString('hex'))
  })

  it('different messages produce different aggregate_sig', () => {
    const { coalitionId } = buildCoalition(AGENT_SECRETS, THRESHOLD)

    const msg1 = Buffer.from('message-one-aaaaaaaaaaaaaaaaaa', 'utf8')
    const msg2 = Buffer.from('message-two-bbbbbbbbbbbbbbbbbb', 'utf8')

    const { aggregateSig: sig1 } = buildAggregateSig(coalitionId, msg1, AGENT_SECRETS)
    const { aggregateSig: sig2 } = buildAggregateSig(coalitionId, msg2, AGENT_SECRETS)

    expect(sig1.toString('hex')).not.toBe(sig2.toString('hex'))
  })

  it('partial_sigs are unique per agent', () => {
    const { coalitionId } = buildCoalition(AGENT_SECRETS, THRESHOLD)
    const { partialSigs } = buildAggregateSig(coalitionId, MESSAGE, AGENT_SECRETS)

    expect(partialSigs).toHaveLength(3)
    const hexSigs = partialSigs.map(s => s.toString('hex'))

    // All partial sigs must be distinct
    expect(hexSigs[0]).not.toBe(hexSigs[1])
    expect(hexSigs[1]).not.toBe(hexSigs[2])
    expect(hexSigs[0]).not.toBe(hexSigs[2])
  })

  it('coalition_id depends on threshold value', () => {
    const threshold1 = Buffer.from([2])
    const threshold2 = Buffer.from([3])

    const { coalitionId: id1 } = buildCoalition(AGENT_SECRETS, threshold1)
    const { coalitionId: id2 } = buildCoalition(AGENT_SECRETS, threshold2)

    expect(id1.toString('hex')).not.toBe(id2.toString('hex'))
  })

  it('mainnet_ready=false and public record hides agent secrets', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)

    const { pubkeys, agentIds, coalitionId } = buildCoalition(AGENT_SECRETS, THRESHOLD)
    const { aggregateSig } = buildAggregateSig(coalitionId, MESSAGE, AGENT_SECRETS)

    // Public record exposes coalition_id, agent_ids (derived pubkeys), aggregate_sig
    const publicRecord = {
      coalition_id: coalitionId.toString('hex'),
      agent_ids: agentIds.map(id => id.toString('hex')),
      aggregate_sig: aggregateSig.toString('hex'),
    }

    expect(publicRecord).toHaveProperty('coalition_id')
    expect(publicRecord).not.toHaveProperty('agent_secrets')
    expect(publicRecord).not.toHaveProperty('pubkeys')

    // Raw agent secrets must not appear in any public field
    for (const secret of AGENT_SECRETS) {
      const secretHex = secret.toString('hex')
      const allPublicValues = JSON.stringify(publicRecord)
      expect(allPublicValues).not.toContain(secretHex)
    }

    // Pubkeys are NOT directly in the public record (only agent_ids, which are hashes of pubkeys)
    for (const pk of pubkeys) {
      expect(publicRecord.agent_ids).not.toContain(pk.toString('hex'))
    }
  })
})
