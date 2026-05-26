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

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function u8(n: number): Buffer {
  return Buffer.from([n])
}

// ---------------------------------------------------------------------------
// Vote-tally primitives (mirrors crates/dark-vote-tally)
//
// voter_hash        = SHA256("voter-hash-v1"   || voter_secret)
// ballot_commitment = SHA256("ballot-v1"        || voter_hash || choice_byte || proposal_id_le[8] || nonce[32])
//   Yes=1, No=2, Abstain=3
// tally_hash        = SHA256("tally-v1"         || proposal_id_le[8] || yes_le[4] || no_le[4] || abstain_le[4])
// ---------------------------------------------------------------------------

const PFX_VOTER   = Buffer.from('voter-hash-v1')
const PFX_BALLOT  = Buffer.from('ballot-v1')
const PFX_TALLY   = Buffer.from('tally-v1')

const CHOICE = { Yes: 1, No: 2, Abstain: 3 } as const
type Choice = keyof typeof CHOICE

function voterHash(secret: Buffer): Buffer {
  if (secret.equals(Buffer.alloc(secret.length))) throw new Error('zero voter secret rejected')
  return sha256(PFX_VOTER, secret)
}

function ballotCommitment(
  vHash: Buffer,
  choice: Choice,
  proposalId: bigint,
  nonce: Buffer,
): Buffer {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes')
  return sha256(PFX_BALLOT, vHash, u8(CHOICE[choice]), u64le(proposalId), nonce)
}

function tallyHash(
  proposalId: bigint,
  yes: number,
  no: number,
  abstain: number,
): Buffer {
  return sha256(PFX_TALLY, u64le(proposalId), u32le(yes), u32le(no), u32le(abstain))
}

// ---------------------------------------------------------------------------
// Tally state machine
// ---------------------------------------------------------------------------
interface Ballot {
  commitment: Buffer
  voterHashHex: string
  choice: Choice
  nonce: Buffer
}

interface TallyState {
  proposalId: bigint
  ballots: Ballot[]
  seenVoterHashes: Set<string>
}

function newTally(proposalId: bigint): TallyState {
  return { proposalId, ballots: [], seenVoterHashes: new Set() }
}

function castBallot(
  state: TallyState,
  voterSecret: Buffer,
  choice: Choice,
  nonce: Buffer,
): TallyState {
  const vh = voterHash(voterSecret)
  const vhHex = vh.toString('hex')
  if (state.seenVoterHashes.has(vhHex)) throw new Error('duplicate voter')
  const commitment = ballotCommitment(vh, choice, state.proposalId, nonce)
  const newState: TallyState = {
    ...state,
    ballots: [...state.ballots, { commitment, voterHashHex: vhHex, choice, nonce }],
    seenVoterHashes: new Set([...state.seenVoterHashes, vhHex]),
  }
  return newState
}

function revealAndTally(
  state: TallyState,
  voterSecret: Buffer,
  choice: Choice,
  nonce: Buffer,
): { yes: number; no: number; abstain: number; tallyHashBuf: Buffer } {
  const vh = voterHash(voterSecret)
  const expected = ballotCommitment(vh, choice, state.proposalId, nonce)
  const found = state.ballots.find(b => b.commitment.equals(expected))
  if (!found) throw new Error('commitment mismatch — wrong nonce or choice')

  let yes = 0, no = 0, abstain = 0
  for (const b of state.ballots) {
    if (b.choice === 'Yes')     yes++
    else if (b.choice === 'No') no++
    else                        abstain++
  }

  return { yes, no, abstain, tallyHashBuf: tallyHash(state.proposalId, yes, no, abstain) }
}

function publicRecord(
  proposalId: bigint,
  yes: number,
  no: number,
  abstain: number,
): object {
  return {
    proposal_id:   proposalId.toString(),
    yes_count:     yes,
    no_count:      no,
    abstain_count: abstain,
    // voter hashes intentionally omitted
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null vote-tally', () => {
  const PROPOSAL = 42n
  const NONCE_A  = Buffer.alloc(32).fill(0xaa)
  const NONCE_B  = Buffer.alloc(32).fill(0xbb)
  const NONCE_C  = Buffer.alloc(32).fill(0xcc)

  const SECRET_A = Buffer.from('voter-secret-alice-000000000000000', 'utf8')
  const SECRET_B = Buffer.from('voter-secret-bob-0000000000000000', 'utf8')
  const SECRET_C = Buffer.from('voter-secret-carol-00000000000000', 'utf8')

  it('3 voters (2 Yes + 1 No) tally counts are correct', () => {
    let state = newTally(PROPOSAL)
    state = castBallot(state, SECRET_A, 'Yes', NONCE_A)
    state = castBallot(state, SECRET_B, 'Yes', NONCE_B)
    state = castBallot(state, SECRET_C, 'No',  NONCE_C)

    const { yes, no, abstain } = revealAndTally(state, SECRET_A, 'Yes', NONCE_A)
    expect(yes).toBe(2)
    expect(no).toBe(1)
    expect(abstain).toBe(0)
  })

  it('wrong nonce fails reveal', () => {
    let state = newTally(PROPOSAL)
    state = castBallot(state, SECRET_A, 'Yes', NONCE_A)

    const wrongNonce = Buffer.alloc(32).fill(0xff)
    expect(() => revealAndTally(state, SECRET_A, 'Yes', wrongNonce)).toThrow('commitment mismatch')
  })

  it('duplicate voter is detected and rejected', () => {
    let state = newTally(PROPOSAL)
    state = castBallot(state, SECRET_A, 'Yes', NONCE_A)

    // Different nonce but same voter secret — still a duplicate
    const nonce2 = Buffer.alloc(32).fill(0x11)
    expect(() => castBallot(state, SECRET_A, 'No', nonce2)).toThrow('duplicate voter')
  })

  it('tally_hash is deterministic for the same counts and proposal_id', () => {
    const h1 = tallyHash(PROPOSAL, 2, 1, 0)
    const h2 = tallyHash(PROPOSAL, 2, 1, 0)
    expect(h1.equals(h2)).toBe(true)

    // Different counts → different hash
    const h3 = tallyHash(PROPOSAL, 1, 2, 0)
    expect(h1.equals(h3)).toBe(false)

    // Different proposal_id → different hash
    const h4 = tallyHash(99n, 2, 1, 0)
    expect(h1.equals(h4)).toBe(false)
  })

  it('zero voter secret is rejected', () => {
    const zeroSecret = Buffer.alloc(32)
    expect(() => voterHash(zeroSecret)).toThrow('zero voter secret rejected')
  })

  it('public record has vote counts but no voter hashes, and mainnet_ready is false', () => {
    let state = newTally(PROPOSAL)
    state = castBallot(state, SECRET_A, 'Yes',     NONCE_A)
    state = castBallot(state, SECRET_B, 'Abstain', NONCE_B)

    const { yes, no, abstain } = revealAndTally(state, SECRET_A, 'Yes', NONCE_A)
    const rec = publicRecord(PROPOSAL, yes, no, abstain) as Record<string, unknown>

    expect(rec['yes_count']).toBe(1)
    expect(rec['no_count']).toBe(0)
    expect(rec['abstain_count']).toBe(1)
    expect('voter_hashes' in rec).toBe(false)
    expect('voters' in rec).toBe(false)
    expect(rec['mainnet_ready']).toBe(false)
  })
})
