import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) {
    for (let i = 0; i < 32; i++) acc[i] ^= h[i]
  }
  return acc
}

// ── pipeline construction ─────────────────────────────────────────────────────

function pipelineId(secret: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('pipeline-v1'), secret, nonce)
}

function stepHash(pipelineIdBuf: Buffer, stepId: number, data: Buffer): Buffer {
  const dataHash = sha256(data)
  return sha256(
    Buffer.from('pipeline-step-v1'),
    pipelineIdBuf,
    Buffer.from([stepId]),
    dataHash
  )
}

function finalHash(stepHashes: Buffer[]): Buffer {
  const xor = xorFold(stepHashes)
  return sha256(Buffer.from('pipeline-final-v1'), xor)
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('dark-null privacy pipeline', () => {
  const secret = Buffer.alloc(32, 0); secret[0] = 0xAA
  const nonce  = Buffer.alloc(32, 0); nonce[0]  = 0xBB

  it('pipeline_id is SHA256("pipeline-v1" || secret || nonce)', () => {
    const pid = pipelineId(secret, nonce)
    const expected = sha256(Buffer.from('pipeline-v1'), secret, nonce)
    expect(pid.equals(expected)).toBe(true)
    expect(pid.length).toBe(32)
    expect(pid.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('step hash uses domain-separated SHA256 over pipeline_id + step_id + SHA256(data)', () => {
    const pid = pipelineId(secret, nonce)
    const data = Buffer.from('note-commitment-data')
    const sh = stepHash(pid, 1, data)
    const dataHash = sha256(data)
    const expected = sha256(
      Buffer.from('pipeline-step-v1'),
      pid,
      Buffer.from([1]),
      dataHash
    )
    expect(sh.equals(expected)).toBe(true)
  })

  it('full 4-step pipeline finalizes with deterministic hash', () => {
    const pid = pipelineId(secret, nonce)
    const steps = [
      stepHash(pid, 1, Buffer.from('note-commitment-data')),
      stepHash(pid, 2, Buffer.from('mixer-deposit-data')),
      stepHash(pid, 3, Buffer.from('shielded-transfer-data')),
      stepHash(pid, 4, Buffer.from('nullifier-record-data')),
    ]
    const fh1 = finalHash(steps)
    const fh2 = finalHash(steps)
    expect(fh1.equals(fh2)).toBe(true)
    expect(fh1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('changing one step changes the final hash', () => {
    const pid = pipelineId(secret, nonce)
    const steps1 = [
      stepHash(pid, 1, Buffer.from('step-a')),
      stepHash(pid, 2, Buffer.from('step-b')),
      stepHash(pid, 3, Buffer.from('step-c')),
      stepHash(pid, 4, Buffer.from('step-d')),
    ]
    const steps2 = [
      stepHash(pid, 1, Buffer.from('step-a')),
      stepHash(pid, 2, Buffer.from('step-DIFFERENT')),
      stepHash(pid, 3, Buffer.from('step-c')),
      stepHash(pid, 4, Buffer.from('step-d')),
    ]
    const fh1 = finalHash(steps1)
    const fh2 = finalHash(steps2)
    expect(fh1.equals(fh2)).toBe(false)
  })

  it('step hashes are unique for different step data', () => {
    const pid = pipelineId(secret, nonce)
    const s1 = stepHash(pid, 1, Buffer.from('commit-data'))
    const s2 = stepHash(pid, 2, Buffer.from('mix-data'))
    const s3 = stepHash(pid, 3, Buffer.from('transfer-data'))
    const s4 = stepHash(pid, 4, Buffer.from('nullify-data'))
    expect(s1.equals(s2)).toBe(false)
    expect(s2.equals(s3)).toBe(false)
    expect(s3.equals(s4)).toBe(false)
    expect(s1.equals(s4)).toBe(false)
  })

  it('public record fields: pipeline_id present, step_count correct, mainnet_ready false', () => {
    const pid = pipelineId(secret, nonce)
    const steps = [
      stepHash(pid, 1, Buffer.from('s1')),
      stepHash(pid, 2, Buffer.from('s2')),
    ]
    const record = {
      pipeline_id: pid.toString('hex'),
      step_count: steps.length,
      complete: true,
      mainnet_ready: false,
    }
    expect(record.mainnet_ready).toBe(false)
    expect(record.step_count).toBe(2)
    expect(record.pipeline_id).toBe(pid.toString('hex'))
    // Step hashes themselves must not appear in JSON
    for (const sh of steps) {
      expect(JSON.stringify(record)).not.toContain(sh.toString('hex'))
    }
  })
})
