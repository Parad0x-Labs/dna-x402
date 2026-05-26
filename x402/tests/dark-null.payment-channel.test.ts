import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// ---------------------------------------------------------------------------
// Payment-channel primitives (mirrors crates/dark-payment-channel)
//
// party_hash       = SHA256("channel-party-v1" || party_secret)
// channel_id       = SHA256("channel-id-v1" || party_a_hash || party_b_hash || total_deposit_le[8])
// sig_hash         = SHA256("state-sig-v1" || channel_id || new_bal_a_le || new_bal_b_le || sequence_le[8])
// settlement_hash  = SHA256("settle-v1"    || channel_id || final_a_le   || final_b_le   || sequence_le[8])
// ---------------------------------------------------------------------------

const PFX_PARTY      = Buffer.from('channel-party-v1')
const PFX_CHANNEL    = Buffer.from('channel-id-v1')
const PFX_SIG        = Buffer.from('state-sig-v1')
const PFX_SETTLE     = Buffer.from('settle-v1')

function partyHash(secret: Buffer): Buffer {
  return sha256(PFX_PARTY, secret)
}

function channelId(partyAHash: Buffer, partyBHash: Buffer, totalDeposit: bigint): Buffer {
  return sha256(PFX_CHANNEL, partyAHash, partyBHash, u64le(totalDeposit))
}

function sigHash(
  chId: Buffer,
  newBalA: bigint,
  newBalB: bigint,
  sequence: bigint,
): Buffer {
  return sha256(PFX_SIG, chId, u64le(newBalA), u64le(newBalB), u64le(sequence))
}

function settlementHash(
  chId: Buffer,
  finalA: bigint,
  finalB: bigint,
  sequence: bigint,
): Buffer {
  return sha256(PFX_SETTLE, chId, u64le(finalA), u64le(finalB), u64le(sequence))
}

// ---------------------------------------------------------------------------
// Channel state machine
// ---------------------------------------------------------------------------
interface ChannelState {
  channelId: Buffer
  balA: bigint
  balB: bigint
  sequence: bigint
  closed: boolean
}

function openChannel(
  secretA: Buffer,
  secretB: Buffer,
  depositA: bigint,
  depositB: bigint,
): ChannelState {
  const phA   = partyHash(secretA)
  const phB   = partyHash(secretB)
  const total = depositA + depositB
  return {
    channelId: channelId(phA, phB, total),
    balA:      depositA,
    balB:      depositB,
    sequence:  0n,
    closed:    false,
  }
}

function updateChannel(
  state: ChannelState,
  newBalA: bigint,
  newBalB: bigint,
  newSequence: bigint,
): ChannelState {
  if (state.closed) throw new Error('channel already closed')
  if (newSequence <= state.sequence) throw new Error('stale sequence')
  const total = state.balA + state.balB
  if (newBalA + newBalB !== total) throw new Error('balance mismatch')
  // Verify sig_hash would be computed here; just return updated state.
  return { ...state, balA: newBalA, balB: newBalB, sequence: newSequence }
}

function settleChannel(state: ChannelState): {
  settleHash: Buffer
  publicRecord: object
} {
  if (state.closed) throw new Error('channel already closed')
  const sh = settlementHash(state.channelId, state.balA, state.balB, state.sequence)
  const publicRecord = {
    channel_id:    state.channelId.toString('hex'),
    sequence:      state.sequence.toString(),
    closed:        true,
    // no balance details exposed
    mainnet_ready: false,
  }
  return { settleHash: sh, publicRecord }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null payment-channel', () => {
  const SECRET_A = Buffer.from('secret-party-a-0000000000000000000', 'utf8')
  const SECRET_B = Buffer.from('secret-party-b-0000000000000000000', 'utf8')

  it('open + 3 updates + settle lifecycle completes without errors', () => {
    let state = openChannel(SECRET_A, SECRET_B, 500n, 500n)
    expect(state.sequence).toBe(0n)
    expect(state.closed).toBe(false)

    state = updateChannel(state, 400n, 600n, 1n)
    state = updateChannel(state, 350n, 650n, 2n)
    state = updateChannel(state, 300n, 700n, 3n)

    expect(state.sequence).toBe(3n)

    const { settleHash, publicRecord } = settleChannel(state)
    expect(settleHash.length).toBe(32)
    const rec = publicRecord as Record<string, unknown>
    expect(rec['closed']).toBe(true)
    expect(rec['mainnet_ready']).toBe(false)
  })

  it('balance sum is preserved through all updates', () => {
    let state = openChannel(SECRET_A, SECRET_B, 800n, 200n)
    const total = state.balA + state.balB // 1000n

    state = updateChannel(state, 750n, 250n, 1n)
    expect(state.balA + state.balB).toBe(total)

    state = updateChannel(state, 100n, 900n, 2n)
    expect(state.balA + state.balB).toBe(total)

    state = updateChannel(state, 999n, 1n, 3n)
    expect(state.balA + state.balB).toBe(total)
  })

  it('stale sequence is rejected', () => {
    let state = openChannel(SECRET_A, SECRET_B, 500n, 500n)
    state = updateChannel(state, 400n, 600n, 5n)

    // sequence 5 already applied — sending 3 is stale
    expect(() => updateChannel(state, 450n, 550n, 3n)).toThrow('stale sequence')
    // same sequence also rejected
    expect(() => updateChannel(state, 450n, 550n, 5n)).toThrow('stale sequence')
  })

  it('already closed channel rejects updates and re-settle', () => {
    let state = openChannel(SECRET_A, SECRET_B, 600n, 400n)
    state = updateChannel(state, 550n, 450n, 1n)
    settleChannel(state) // first settle ok (returns result, does not mutate)

    // Simulate a closed flag
    const closedState: ChannelState = { ...state, closed: true }
    expect(() => updateChannel(closedState, 500n, 500n, 2n)).toThrow('channel already closed')
    expect(() => settleChannel(closedState)).toThrow('channel already closed')
  })

  it('balance mismatch is detected in update', () => {
    const state = openChannel(SECRET_A, SECRET_B, 500n, 500n)
    // 400 + 500 = 900 ≠ 1000
    expect(() => updateChannel(state, 400n, 500n, 1n)).toThrow('balance mismatch')
  })

  it('public record has channel_id + sequence + closed, but no balance fields, and mainnet_ready is false', () => {
    let state = openChannel(SECRET_A, SECRET_B, 700n, 300n)
    state = updateChannel(state, 600n, 400n, 1n)
    const { publicRecord } = settleChannel(state)
    const rec = publicRecord as Record<string, unknown>

    expect(typeof rec['channel_id']).toBe('string')
    expect((rec['channel_id'] as string).length).toBe(64) // 32-byte hex
    expect(rec['sequence']).toBe('1')
    expect(rec['closed']).toBe(true)
    // balance fields must NOT be present
    expect('balA' in rec).toBe(false)
    expect('balB' in rec).toBe(false)
    expect('bal_a' in rec).toBe(false)
    expect('bal_b' in rec).toBe(false)
    expect(rec['mainnet_ready']).toBe(false)
  })
})
