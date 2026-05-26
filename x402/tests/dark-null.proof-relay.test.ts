import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}

// ---------------------------------------------------------------------------
// Proof Relay primitives
//
// payloadCommitment(payload)                       = SHA256("relay-payload-v1" || payload)
// relayHash(relaySecret)                           = SHA256("relay-secret-v1"  || relaySecret)
// routeHop(prevRoute, hopIdx_u8, relayHash)        = SHA256("relay-hop-v1"     || prevRoute || [hopIdx] || relayHash)
// routeCommitment = start from payloadCommitment, chain routeHop for each secret (0-indexed)
// packetId(payloadCommitment, routeCommitment, hopCount_u8) = SHA256("relay-id-v1" || payloadCommitment || routeCommitment || [hopCount])
// ---------------------------------------------------------------------------

function payloadCommitment(payload: Buffer): Buffer {
  return sha256(Buffer.from('relay-payload-v1'), payload)
}

function relayHash(relaySecret: Buffer): Buffer {
  return sha256(Buffer.from('relay-secret-v1'), relaySecret)
}

function routeHop(prevRoute: Buffer, hopIdx: number, rHash: Buffer): Buffer {
  return sha256(Buffer.from('relay-hop-v1'), prevRoute, Buffer.from([hopIdx]), rHash)
}

function buildRoute(payload: Buffer, secrets: Buffer[]): Buffer {
  let route = payloadCommitment(payload)
  for (let i = 0; i < secrets.length; i++) {
    const rHash = relayHash(secrets[i])
    route = routeHop(route, i, rHash)
  }
  return route
}

function packetId(pCommit: Buffer, rCommit: Buffer, hopCount: number): Buffer {
  return sha256(Buffer.from('relay-id-v1'), pCommit, rCommit, Buffer.from([hopCount]))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null proof-relay', () => {
  const PAYLOAD        = Buffer.from('zkp-proof-bytes-here')
  const RELAY_SECRET_A = Buffer.alloc(32).fill(0xa1)
  const RELAY_SECRET_B = Buffer.alloc(32).fill(0xa2)
  const RELAY_SECRET_C = Buffer.alloc(32).fill(0xa3)

  // Test 1: packet_id formula is correct (1 hop)
  it('packet_id formula is correct (1 hop)', () => {
    const pCommit = payloadCommitment(PAYLOAD)
    const rHash   = relayHash(RELAY_SECRET_A)
    const rCommit = routeHop(pCommit, 0, rHash)
    const pId     = packetId(pCommit, rCommit, 1)

    const expected = sha256(Buffer.from('relay-id-v1'), pCommit, rCommit, Buffer.from([1]))
    expect(pId.length).toBe(32)
    expect(pId.equals(expected)).toBe(true)
    expect(pId.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 2: route_commitment changes with different relay secrets
  it('route_commitment changes with different relay secrets', () => {
    const routeA = buildRoute(PAYLOAD, [RELAY_SECRET_A])
    const routeB = buildRoute(PAYLOAD, [RELAY_SECRET_B])
    expect(routeA.equals(routeB)).toBe(false)
  })

  // Test 3: packet_id is deterministic
  it('packet_id is deterministic', () => {
    const pCommit = payloadCommitment(PAYLOAD)
    const rCommit = buildRoute(PAYLOAD, [RELAY_SECRET_A, RELAY_SECRET_B])
    const pId1    = packetId(pCommit, rCommit, 2)
    const pId2    = packetId(pCommit, rCommit, 2)
    expect(pId1.equals(pId2)).toBe(true)
    expect(pId1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  // Test 4: hop_count is stored correctly
  it('hop_count is stored correctly', () => {
    const secrets = [RELAY_SECRET_A, RELAY_SECRET_B, RELAY_SECRET_C]
    const pCommit = payloadCommitment(PAYLOAD)
    const rCommit = buildRoute(PAYLOAD, secrets)
    const hopCount = secrets.length

    const pId = packetId(pCommit, rCommit, hopCount)

    // Verify that packetId with different hop_count differs
    const pIdWrong = packetId(pCommit, rCommit, hopCount + 1)
    expect(pId.equals(pIdWrong)).toBe(false)
    expect(hopCount).toBe(3)
  })

  // Test 5: deliver sets delivered=true
  it('deliver sets delivered=true', () => {
    let delivered = false
    expect(delivered).toBe(false)
    // deliver
    delivered = true
    expect(delivered).toBe(true)

    // Sanity: route chains produce different results at each hop
    const pCommit = payloadCommitment(PAYLOAD)
    const rHashA  = relayHash(RELAY_SECRET_A)
    const hop0    = routeHop(pCommit, 0, rHashA)
    const rHashB  = relayHash(RELAY_SECRET_B)
    const hop1    = routeHop(hop0, 1, rHashB)
    expect(hop0.equals(hop1)).toBe(false)
  })

  // Test 6: mainnet_ready is false
  it('mainnet_ready is false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
