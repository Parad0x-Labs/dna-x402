import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Commitment Accumulator
// Mirrors crates/dark-commitment-accumulator/src/lib.rs
// ---------------------------------------------------------------------------

const ACC_GENESIS_TAG   = Buffer.from('acc-genesis-v1')
const ACC_ELEM_TAG      = Buffer.from('acc-elem-v1')
const ACC_UPDATE_TAG    = Buffer.from('acc-update-v1')
const ACC_WITNESS_TAG   = Buffer.from('acc-witness-v1')

function accGenesis(): Buffer {
  return sha256(ACC_GENESIS_TAG, Buffer.alloc(32, 0))
}

function elementHash(elementBytes: Buffer): Buffer {
  if (elementBytes.length === 0) throw new Error('element must not be empty')
  return sha256(ACC_ELEM_TAG, elementBytes)
}

function accAdd(oldValue: Buffer, elemHash: Buffer): Buffer {
  return sha256(ACC_UPDATE_TAG, oldValue, elemHash)
}

function witnessHash(accValue: Buffer, elemHash: Buffer): Buffer {
  return sha256(ACC_WITNESS_TAG, accValue, elemHash)
}

interface AccWitness {
  element_hash: Buffer
  witness: Buffer
}

function accAddAndWitness(acc: Buffer, elementBytes: Buffer): { newAcc: Buffer; witness: AccWitness } {
  const elemHash = elementHash(elementBytes)
  const newAcc   = accAdd(acc, elemHash)
  const witness  = witnessHash(newAcc, elemHash)
  return { newAcc, witness: { element_hash: elemHash, witness } }
}

function verifyMembership(acc: Buffer, elementBytes: Buffer, w: AccWitness): boolean {
  const recomputedElemHash    = elementHash(elementBytes)
  const recomputedWitnessHash = witnessHash(acc, recomputedElemHash)
  return recomputedElemHash.equals(w.element_hash) && recomputedWitnessHash.equals(w.witness)
}

const mainnet_ready = false

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null commitment-accumulator', () => {
  it('mainnet_ready flag is false', () => {
    expect(mainnet_ready).toBe(false)
  })

  it('add element and verify membership', () => {
    const acc0 = accGenesis()
    const elem = Buffer.from('element-alpha', 'utf8')
    const { newAcc, witness } = accAddAndWitness(acc0, elem)
    expect(verifyMembership(newAcc, elem, witness)).toBe(true)
  })

  it('non-member rejected (different element)', () => {
    const acc0 = accGenesis()
    const elem  = Buffer.from('element-real', 'utf8')
    const other = Buffer.from('element-fake', 'utf8')
    const { newAcc, witness } = accAddAndWitness(acc0, elem)
    expect(verifyMembership(newAcc, other, witness)).toBe(false)
  })

  it('empty element guard throws', () => {
    expect(() => elementHash(Buffer.alloc(0))).toThrow()
  })

  it('acc value changes with each add', () => {
    let acc = accGenesis()
    const values: string[] = [acc.toString('hex')]
    for (let i = 0; i < 4; i++) {
      const { newAcc } = accAddAndWitness(acc, Buffer.from(`item-${i}`, 'utf8'))
      values.push(newAcc.toString('hex'))
      acc = newAcc
    }
    expect(new Set(values).size).toBe(values.length)
  })

  it('witness binds to acc value (different acc → different witness)', () => {
    const acc0 = accGenesis()
    const elem  = Buffer.from('shared-element', 'utf8')

    const { newAcc: acc1, witness: w1 } = accAddAndWitness(acc0, elem)
    // Build a second accumulator by adding a different first element
    const { newAcc: acc0b } = accAddAndWitness(acc0, Buffer.from('different-first', 'utf8'))
    const { newAcc: acc2, witness: w2 } = accAddAndWitness(acc0b, elem)

    expect(w1.witness.equals(w2.witness)).toBe(false)
    expect(acc1.equals(acc2)).toBe(false)
  })

  it('5-element batch: all verify', () => {
    let acc = accGenesis()
    const entries: Array<{ elem: Buffer; witness: AccWitness; acc: Buffer }> = []

    for (let i = 0; i < 5; i++) {
      const elem = Buffer.from(`batch-elem-${i}`, 'utf8')
      const { newAcc, witness } = accAddAndWitness(acc, elem)
      acc = newAcc
      entries.push({ elem, witness, acc })
    }

    // Verify the last entry's witness against its corresponding acc state
    const last = entries[entries.length - 1]
    expect(verifyMembership(last.acc, last.elem, last.witness)).toBe(true)

    // Verify each element using its accumulated state at insertion time
    for (const entry of entries) {
      expect(verifyMembership(entry.acc, entry.elem, entry.witness)).toBe(true)
    }
  })
})
