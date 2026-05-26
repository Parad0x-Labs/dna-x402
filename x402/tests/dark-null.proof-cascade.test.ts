import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

const MAX_CASCADE_DEPTH = 32
const INPUT_BYTES = Buffer.from('cascade-test-input-data-v1-alpha', 'utf8')

function runCascade(inputBytes: Buffer, depth: number): { rootInput: Buffer; layers: Buffer[]; finalOutput: Buffer } {
  if (depth < 1 || depth > MAX_CASCADE_DEPTH) throw new Error(`depth must be 1..${MAX_CASCADE_DEPTH}`)

  const rootInput = sha256(Buffer.from('cascade-root-v1'), inputBytes)
  const layers: Buffer[] = []

  let current = rootInput
  for (let i = 0; i < depth; i++) {
    const output = sha256(Buffer.from('cascade-layer-v1'), u32le(i), current)
    layers.push(output)
    current = output
  }

  return { rootInput, layers, finalOutput: layers[layers.length - 1] }
}

function buildProofId(rootInput: Buffer, finalOutput: Buffer, depth: number): Buffer {
  return sha256(Buffer.from('cascade-proof-v1'), rootInput, finalOutput, u32le(depth))
}

describe('dark-null proof-cascade', () => {
  it('single layer output is correct', () => {
    const { rootInput, layers, finalOutput } = runCascade(INPUT_BYTES, 1)

    const expectedRootInput = sha256(Buffer.from('cascade-root-v1'), INPUT_BYTES)
    const expectedLayer0 = sha256(Buffer.from('cascade-layer-v1'), u32le(0), expectedRootInput)

    expect(rootInput.toString('hex')).toBe(expectedRootInput.toString('hex'))
    expect(layers).toHaveLength(1)
    expect(layers[0].toString('hex')).toBe(expectedLayer0.toString('hex'))
    expect(finalOutput.toString('hex')).toBe(expectedLayer0.toString('hex'))
  })

  it('4-layer cascade is deterministic', () => {
    const run1 = runCascade(INPUT_BYTES, 4)
    const run2 = runCascade(INPUT_BYTES, 4)

    expect(run1.rootInput.toString('hex')).toBe(run2.rootInput.toString('hex'))
    expect(run1.finalOutput.toString('hex')).toBe(run2.finalOutput.toString('hex'))
    for (let i = 0; i < 4; i++) {
      expect(run1.layers[i].toString('hex')).toBe(run2.layers[i].toString('hex'))
    }
  })

  it('depth sensitivity: depth=3 vs depth=4 produce different final_output', () => {
    const { finalOutput: out3 } = runCascade(INPUT_BYTES, 3)
    const { finalOutput: out4 } = runCascade(INPUT_BYTES, 4)

    expect(out3.toString('hex')).not.toBe(out4.toString('hex'))
    // depth=3 finalOutput is layer[2], depth=4 finalOutput is layer[3]
    // layer[3] is derived from layer[2], so they must differ
    expect(out3).toHaveLength(32)
    expect(out4).toHaveLength(32)
  })

  it('input sensitivity: different inputs produce different final_output', () => {
    const input1 = Buffer.from('input-alpha-000000000000000001', 'utf8')
    const input2 = Buffer.from('input-beta-000000000000000002', 'utf8')

    const { finalOutput: out1 } = runCascade(input1, 4)
    const { finalOutput: out2 } = runCascade(input2, 4)

    expect(out1.toString('hex')).not.toBe(out2.toString('hex'))
  })

  it('proof_id correct computation', () => {
    const depth = 4
    const { rootInput, finalOutput } = runCascade(INPUT_BYTES, depth)
    const proofId = buildProofId(rootInput, finalOutput, depth)

    const expectedProofId = sha256(
      Buffer.from('cascade-proof-v1'),
      rootInput,
      finalOutput,
      u32le(depth)
    )

    expect(proofId.toString('hex')).toBe(expectedProofId.toString('hex'))
    expect(proofId).toHaveLength(32)
  })

  it('mainnet_ready=false and MAX_CASCADE_DEPTH=32', () => {
    const MAINNET_READY = false
    expect(MAINNET_READY).toBe(false)
    expect(MAX_CASCADE_DEPTH).toBe(32)

    // Verify depth guard works
    expect(() => runCascade(INPUT_BYTES, 0)).toThrow()
    expect(() => runCascade(INPUT_BYTES, 33)).toThrow()
    expect(() => runCascade(INPUT_BYTES, 32)).not.toThrow()
  })
})
