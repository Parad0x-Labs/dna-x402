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
// AgentReceipt (mirrors crates/dark-agent-receipt/src/lib.rs)
//
// agent_id          = SHA256("agent-id-v1" || agent_secret)
// payload_hash      = SHA256("action-payload-v1" || payload)
// action_hash       = SHA256("agent-action-v1" || agent_id || [action_type]
//                             || payload_hash || executed_at_le[8])
// receipt_chain_hash= SHA256("action-chain-v1" || prev_action_hash || action_hash)
//
// Errors: ZeroSecret, EmptyPayload
// ---------------------------------------------------------------------------

const GENESIS_HASH = Buffer.alloc(32, 0)  // sentinel for the first action in a chain

interface ActionRecord {
  agent_id: Buffer          // 32 bytes — derived; kept private
  action_type: number       // u8
  payload_hash: Buffer      // 32 bytes — hides payload content
  action_hash: Buffer       // 32 bytes
  executed_at: bigint
}

interface ReceiptChain {
  chain_hash: Buffer        // 32 bytes
  head: ActionRecord
}

function agentId(agent_secret: Buffer): Buffer {
  if (agent_secret.length === 0 || agent_secret.equals(Buffer.alloc(agent_secret.length, 0))) {
    throw new Error('ZeroSecret')
  }
  return sha256(Buffer.from('agent-id-v1'), agent_secret)
}

function payloadHash(payload: Buffer): Buffer {
  if (payload.length === 0) throw new Error('EmptyPayload')
  return sha256(Buffer.from('action-payload-v1'), payload)
}

function actionHash(
  agent_id: Buffer,
  action_type: number,
  p_hash: Buffer,
  executed_at: bigint,
): Buffer {
  return sha256(
    Buffer.from('agent-action-v1'),
    agent_id,
    u8(action_type),
    p_hash,
    u64le(executed_at),
  )
}

function receiptChainHash(prev_action_hash: Buffer, a_hash: Buffer): Buffer {
  return sha256(Buffer.from('action-chain-v1'), prev_action_hash, a_hash)
}

function createAction(
  agent_secret: Buffer,
  action_type: number,
  payload: Buffer,
  executed_at: bigint,
  prev_action_hash = GENESIS_HASH,
): ReceiptChain {
  const aid    = agentId(agent_secret)
  const p_hash = payloadHash(payload)
  const a_hash = actionHash(aid, action_type, p_hash, executed_at)
  const chain  = receiptChainHash(prev_action_hash, a_hash)

  return {
    chain_hash: chain,
    head: { agent_id: aid, action_type, payload_hash: p_hash, action_hash: a_hash, executed_at },
  }
}

function verifyReceipt(
  chain: ReceiptChain,
  agent_secret: Buffer,
  action_type: number,
  payload: Buffer,
  executed_at: bigint,
  prev_action_hash = GENESIS_HASH,
): boolean {
  let aid: Buffer
  try { aid = agentId(agent_secret) } catch { return false }
  let p_hash: Buffer
  try { p_hash = payloadHash(payload) } catch { return false }

  const expected_action  = actionHash(aid, action_type, p_hash, executed_at)
  const expected_chain   = receiptChainHash(prev_action_hash, expected_action)

  return (
    expected_action.equals(chain.head.action_hash) &&
    expected_chain.equals(chain.chain_hash)
  )
}

function publicRecord(chain: ReceiptChain): object {
  return {
    action_hash:       chain.head.action_hash.toString('hex'),
    payload_hash:      chain.head.payload_hash.toString('hex'),
    chain_hash:        chain.chain_hash.toString('hex'),
    action_type:       chain.head.action_type,
    executed_at:       chain.head.executed_at.toString(),
    // agent_id is intentionally absent — private
    mainnet_ready:     false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null agent-receipt', () => {
  const SECRET  = Buffer.from('super-secret-agent-key-0000000000', 'utf8').subarray(0, 32)
  const PAYLOAD = Buffer.from('{"action":"transfer","amount":42}')

  it('create action + record + verify passes for correct inputs', () => {
    const chain = createAction(SECRET, 1, PAYLOAD, 1_700_000_000n)
    expect(chain.head.action_hash.length).toBe(32)
    expect(chain.chain_hash.length).toBe(32)
    expect(verifyReceipt(chain, SECRET, 1, PAYLOAD, 1_700_000_000n)).toBe(true)
  })

  it('chain links: 3 chained receipts form a valid hash chain', () => {
    const c1 = createAction(SECRET, 1, Buffer.from('step-one'),   1000n)
    const c2 = createAction(SECRET, 2, Buffer.from('step-two'),   2000n, c1.head.action_hash)
    const c3 = createAction(SECRET, 3, Buffer.from('step-three'), 3000n, c2.head.action_hash)

    // Each chain_hash must be deterministically recomputable
    const expected_c2_chain = receiptChainHash(c1.head.action_hash, c2.head.action_hash)
    const expected_c3_chain = receiptChainHash(c2.head.action_hash, c3.head.action_hash)

    expect(c2.chain_hash.equals(expected_c2_chain)).toBe(true)
    expect(c3.chain_hash.equals(expected_c3_chain)).toBe(true)

    // All three chain hashes must be distinct
    expect(c1.chain_hash.equals(c2.chain_hash)).toBe(false)
    expect(c2.chain_hash.equals(c3.chain_hash)).toBe(false)
  })

  it('verify_receipt passes for a correctly re-verified receipt', () => {
    const chain = createAction(SECRET, 5, PAYLOAD, 999_999n)
    expect(verifyReceipt(chain, SECRET, 5, PAYLOAD, 999_999n)).toBe(true)
    // Wrong action_type fails
    expect(verifyReceipt(chain, SECRET, 6, PAYLOAD, 999_999n)).toBe(false)
    // Wrong timestamp fails
    expect(verifyReceipt(chain, SECRET, 5, PAYLOAD, 1_000_000n)).toBe(false)
  })

  it('zero secret is rejected', () => {
    expect(() => agentId(Buffer.alloc(32, 0))).toThrow('ZeroSecret')
    expect(() => createAction(Buffer.alloc(32, 0), 1, PAYLOAD, 0n)).toThrow('ZeroSecret')
  })

  it('empty payload is rejected', () => {
    expect(() => payloadHash(Buffer.alloc(0))).toThrow('EmptyPayload')
    expect(() => createAction(SECRET, 1, Buffer.alloc(0), 0n)).toThrow('EmptyPayload')
  })

  it('public record hides agent_id — not present in output', () => {
    const chain = createAction(SECRET, 2, PAYLOAD, 500n)
    const rec   = publicRecord(chain) as Record<string, unknown>

    // agent_id key must be absent
    expect('agent_id' in rec).toBe(false)

    // The hex of the internal agent_id must not appear in the serialised record
    const aid_hex  = chain.head.agent_id.toString('hex')
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain(aid_hex)
    expect(rec['mainnet_ready']).toBe(false)
  })
})
