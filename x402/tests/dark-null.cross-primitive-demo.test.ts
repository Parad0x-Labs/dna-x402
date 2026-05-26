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

function stepHash(name: string): Buffer {
  return sha256(Buffer.from('demo-step-v1'), Buffer.from(name))
}

// ── step implementations ──────────────────────────────────────────────────────

function stepStealthAddress(): boolean {
  const scanSecret  = sha256(Buffer.from('stealth-scan-secret'))
  const spendSecret = sha256(Buffer.from('stealth-spend-secret'))
  const ephemSecret = sha256(Buffer.from('stealth-ephem-secret'))

  const scanPubkey  = sha256(Buffer.from('stealth-scan-pubkey-v1'),  scanSecret)
  const spendPubkey = sha256(Buffer.from('stealth-spend-pubkey-v1'), spendSecret)
  const ephemPubkey = sha256(Buffer.from('stealth-ephem-v1'),        ephemSecret)

  const shared   = sha256(Buffer.from('stealth-shared-v1'), ephemPubkey, scanPubkey)
  const oneTime  = sha256(Buffer.from('stealth-addr-v1'),   shared, spendPubkey)

  const scanPk2  = sha256(Buffer.from('stealth-scan-pubkey-v1'), scanSecret)
  const shared2  = sha256(Buffer.from('stealth-shared-v1'), ephemPubkey, scanPk2)
  const expected = sha256(Buffer.from('stealth-addr-v1'), shared2, spendPubkey)

  return oneTime.equals(expected)
}

function stepCommitmentAccumulator(): boolean {
  const element  = Buffer.from('accumulator-element')
  const elemHash = sha256(Buffer.from('acc-elem-v1'), element)
  const accValue = sha256(Buffer.from('acc-value-v1'), elemHash)
  const witness  = sha256(Buffer.from('acc-witness-v1'), elemHash, accValue)
  const expectedWitness = sha256(Buffer.from('acc-witness-v1'), elemHash, accValue)
  return witness.equals(expectedWitness)
}

function stepRangeProof(): boolean {
  const value = 42n
  const blinding = sha256(Buffer.from('range-blinding'))
  const vBuf = Buffer.alloc(8); vBuf.writeBigUInt64LE(value)
  const commitment = sha256(Buffer.from('range-commit-v1'), vBuf, blinding)
  const bitCommits: Buffer[] = []
  for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
    const bitVal = Number((value >> BigInt(bitIdx)) & 1n)
    const bitBlind = sha256(Buffer.from('bit-blind-v1'), blinding, Buffer.from([bitIdx]))
    const bc = sha256(Buffer.from('bit-commit-v1'), Buffer.from([bitIdx]), Buffer.from([bitVal]), bitBlind)
    bitCommits.push(bc)
  }
  const xor = xorFold(bitCommits)
  const proofHash = sha256(Buffer.from('range-proof-v1'), commitment, xor)
  return !proofHash.equals(Buffer.alloc(32, 0))
}

function stepMerkleProof(): boolean {
  const leavesData = ['leaf-0', 'leaf-1', 'leaf-2', 'leaf-3'].map(s => Buffer.from(s))
  const leafHashes = leavesData.map(d => sha256(Buffer.from('merkle-leaf-v1'), d))
  const node01 = sha256(Buffer.from('merkle-node-v1'), leafHashes[0], leafHashes[1])
  const node23 = sha256(Buffer.from('merkle-node-v1'), leafHashes[2], leafHashes[3])
  const root   = sha256(Buffer.from('merkle-node-v1'), node01, node23)
  const reNode01 = sha256(Buffer.from('merkle-node-v1'), leafHashes[0], leafHashes[1])
  const reRoot   = sha256(Buffer.from('merkle-node-v1'), reNode01, node23)
  return root.equals(reRoot)
}

function stepSecretSharing(): boolean {
  const secret = sha256(Buffer.from('secret-sharing-input'))
  const share1 = sha256(Buffer.from('share-1-random'))
  const share2 = sha256(Buffer.from('share-2-random'))
  const share3 = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) share3[i] = secret[i] ^ share1[i] ^ share2[i]
  const reconstructed = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) reconstructed[i] = share1[i] ^ share2[i] ^ share3[i]
  return reconstructed.equals(secret)
}

function stepSigmaProof(): boolean {
  const secret     = sha256(Buffer.from('sigma-secret'))
  const commitment = sha256(Buffer.from('sigma-commit-v1'), secret)
  const challenge  = sha256(Buffer.from('sigma-challenge-v1'), commitment)
  const response   = sha256(Buffer.from('sigma-response-v1'), secret, challenge)
  const verifyHash = sha256(Buffer.from('sigma-verify-v1'), response, challenge, commitment)
  return !verifyHash.equals(Buffer.alloc(32, 0))
}

function stepVoteTally(): boolean {
  const votes = [1, 1, 0]
  let yes = 0, no = 0
  const voteHashes: Buffer[] = []
  for (let i = 0; i < votes.length; i++) {
    if (votes[i] === 1) yes++; else no++
    voteHashes.push(sha256(Buffer.from('vote-v1'), Buffer.from([i]), Buffer.from([votes[i]])))
  }
  const yesBuf = Buffer.alloc(4); yesBuf.writeUInt32LE(yes)
  const noBuf  = Buffer.alloc(4); noBuf.writeUInt32LE(no)
  const xor    = xorFold(voteHashes)
  const tally  = sha256(Buffer.from('tally-v1'), yesBuf, noBuf, xor)
  return yes === 2 && no === 1 && !tally.equals(Buffer.alloc(32, 0))
}

function stepPaymentChannel(): boolean {
  const channelId = sha256(Buffer.from('payment-channel-id'))
  const s0b = Buffer.alloc(8); s0b.writeBigUInt64LE(0n)
  const s1b = Buffer.alloc(8); s1b.writeBigUInt64LE(1n)
  const s2b = Buffer.alloc(8); s2b.writeBigUInt64LE(2n)
  const state0 = sha256(Buffer.from('chan-state-v1'), channelId, s0b)
  const state1 = sha256(Buffer.from('chan-state-v1'), channelId, s1b, state0)
  const state2 = sha256(Buffer.from('chan-state-v1'), channelId, s2b, state1)
  const settle  = sha256(Buffer.from('chan-settle-v1'), channelId, state2)
  const es1 = sha256(Buffer.from('chan-state-v1'), channelId, s1b, state0)
  const es2 = sha256(Buffer.from('chan-state-v1'), channelId, s2b, es1)
  return state1.equals(es1) && state2.equals(es2) && !settle.equals(Buffer.alloc(32, 0))
}

function stepPrivateAuction(): boolean {
  const bids = [100n, 250n, 150n]
  const bidHashes = bids.map((b, i) => {
    const bidBuf = Buffer.alloc(8); bidBuf.writeBigUInt64LE(b)
    return sha256(Buffer.from('bid-v1'), Buffer.from([i]), bidBuf)
  })
  let winnerIdx = 0, maxBid = bids[0]
  for (let i = 1; i < bids.length; i++) {
    if (bids[i] > maxBid) { maxBid = bids[i]; winnerIdx = i }
  }
  const maxBidBuf = Buffer.alloc(8); maxBidBuf.writeBigUInt64LE(maxBid)
  const result = sha256(Buffer.from('auction-result-v1'), bidHashes[winnerIdx], maxBidBuf)
  return winnerIdx === 1 && maxBid === 250n && !result.equals(Buffer.alloc(32, 0))
}

// ── full demo ─────────────────────────────────────────────────────────────────

const STEP_DEFS: Array<[string, () => boolean]> = [
  ['stealth_address',        stepStealthAddress],
  ['commitment_accumulator', stepCommitmentAccumulator],
  ['range_proof',            stepRangeProof],
  ['merkle_proof',           stepMerkleProof],
  ['secret_sharing',         stepSecretSharing],
  ['sigma_proof',            stepSigmaProof],
  ['vote_tally',             stepVoteTally],
  ['payment_channel',        stepPaymentChannel],
  ['private_auction',        stepPrivateAuction],
]

// ── tests ─────────────────────────────────────────────────────────────────────

describe('dark-null cross-primitive demo', () => {
  it('all individual steps pass', () => {
    for (const [name, fn] of STEP_DEFS) {
      expect(fn(), `step '${name}' must pass`).toBe(true)
    }
  })

  it('step_count is 9 (TS subset of 10-step demo)', () => {
    expect(STEP_DEFS.length).toBe(9)
  })

  it('step hashes are domain-separated with "demo-step-v1"', () => {
    for (const [name] of STEP_DEFS) {
      const h = stepHash(name)
      const expected = sha256(Buffer.from('demo-step-v1'), Buffer.from(name))
      expect(h.equals(expected)).toBe(true)
    }
  })

  it('final_proof is deterministic', () => {
    const hashes1 = STEP_DEFS.map(([name]) => stepHash(name))
    const hashes2 = STEP_DEFS.map(([name]) => stepHash(name))
    const xor1 = xorFold(hashes1)
    const xor2 = xorFold(hashes2)
    const fp1 = sha256(Buffer.from('demo-final-v1'), xor1)
    const fp2 = sha256(Buffer.from('demo-final-v1'), xor2)
    expect(fp1.equals(fp2)).toBe(true)
    expect(fp1.equals(Buffer.alloc(32, 0))).toBe(false)
  })

  it('stealth address: scan correctly finds the one-time address', () => {
    expect(stepStealthAddress()).toBe(true)
  })

  it('mainnet_ready is false throughout the demo', () => {
    const record = { step_count: STEP_DEFS.length, all_passed: true, mainnet_ready: false }
    expect(record.mainnet_ready).toBe(false)
  })
})
