import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Crypto primitives (mirrors dark-null-token/src/lib.rs)
// ---------------------------------------------------------------------------

function sha256(...inputs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const i of inputs) h.update(i)
  return h.digest()
}

/** little-endian u64 */
function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function hexEncode(buf: Buffer): string {
  return buf.toString('hex')
}

// ---------------------------------------------------------------------------
// Privacy token primitives (TypeScript mirror of dark-null-token/src/lib.rs)
//
// Domain tags must match the Rust source exactly (note: no trailing null byte
// — Rust passes b"token-owner-v1" as a raw byte slice, not a C-string).
// ---------------------------------------------------------------------------

/** SHA256("token-owner-v1" || owner_secret) */
function computeOwnerHash(ownerSecret: Buffer): Buffer {
  return sha256(Buffer.from('token-owner-v1'), ownerSecret)
}

/** SHA256("token-note-v1" || amount_le || owner_hash || nonce) */
function computeCommitment(amount: bigint, ownerHash: Buffer, nonce: Buffer): Buffer {
  return sha256(Buffer.from('token-note-v1'), u64le(amount), ownerHash, nonce)
}

/** SHA256("token-null-v1" || input_commitment || owner_hash) */
function computeNullifier(commitment: Buffer, ownerHash: Buffer): Buffer {
  return sha256(Buffer.from('token-null-v1'), commitment, ownerHash)
}

/** SHA256("transfer-proof-v1" || input_nullifier || output_commitment) */
function computeTransferProof(inputNullifier: Buffer, outputCommitment: Buffer): Buffer {
  return sha256(Buffer.from('transfer-proof-v1'), inputNullifier, outputCommitment)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenNote {
  commitment: Buffer
  owner_hash: Buffer
}

interface TokenTransfer {
  input_nullifier: Buffer
  output_commitment: Buffer
  transfer_proof: Buffer
}

/** In-memory shielded ledger — matches the privacy contract of ShieldedLedger in Rust. */
interface ShieldedLedger {
  commitments: Set<string>   // hex-encoded commitment bytes
  nullifiers: Set<string>    // hex-encoded spent nullifier bytes
}

function newLedger(): ShieldedLedger {
  return { commitments: new Set(), nullifiers: new Set() }
}

function mintNote(ownerSecret: Buffer, amount: bigint, nonce: Buffer): TokenNote {
  const ownerHash = computeOwnerHash(ownerSecret)
  const commitment = computeCommitment(amount, ownerHash, nonce)
  return { commitment, owner_hash: ownerHash }
}

type TransferResult =
  | { ok: TokenTransfer }
  | { err: 'CommitmentNotFound' | 'OwnershipMismatch' | 'NullifierAlreadySpent' }

function transferNote(
  ledger: ShieldedLedger,
  input: TokenNote,
  ownerSecret: Buffer,
  recipientOwnerHash: Buffer,
  recipientNonce: Buffer,
  amount: bigint,
): TransferResult {
  // 1. Commitment must exist in ledger
  const commitHex = hexEncode(input.commitment)
  if (!ledger.commitments.has(commitHex)) {
    return { err: 'CommitmentNotFound' }
  }

  // 2. Verify ownership
  const derivedOwnerHash = computeOwnerHash(ownerSecret)
  if (!derivedOwnerHash.equals(input.owner_hash)) {
    return { err: 'OwnershipMismatch' }
  }

  // 3. Derive nullifier and check for double-spend
  const inputNullifier = computeNullifier(input.commitment, derivedOwnerHash)
  const nullHex = hexEncode(inputNullifier)
  if (ledger.nullifiers.has(nullHex)) {
    return { err: 'NullifierAlreadySpent' }
  }

  // 4. Build output commitment
  const outputCommitment = computeCommitment(amount, recipientOwnerHash, recipientNonce)

  // 5. Build transfer proof
  const transferProof = computeTransferProof(inputNullifier, outputCommitment)

  // 6. Update ledger state
  ledger.commitments.delete(commitHex)
  ledger.commitments.add(hexEncode(outputCommitment))
  ledger.nullifiers.add(nullHex)

  return { ok: { input_nullifier: inputNullifier, output_commitment: outputCommitment, transfer_proof: transferProof } }
}

/** Public record — mirrors ledger_public_record() in Rust. */
function ledgerPublicRecord(ledger: ShieldedLedger): Record<string, unknown> {
  return {
    commitment_count: ledger.commitments.size,
    nullifier_count: ledger.nullifiers.size,
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function ownerSecret(): Buffer {
  const s = Buffer.alloc(32, 0)
  s[0] = 0xab
  return s
}

function recipientSecret(): Buffer {
  const s = Buffer.alloc(32, 0)
  s[0] = 0xcc
  return s
}

function nonce(seed: number): Buffer {
  const n = Buffer.alloc(32, 0)
  n[0] = seed
  return n
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null privacy token', () => {
  it('happy path: mint, add to ledger, transfer', () => {
    const secret = ownerSecret()
    const note = mintNote(secret, 1_000n, nonce(1))

    expect(note.commitment.length).toBe(32)
    expect(note.owner_hash.length).toBe(32)
    expect(note.commitment.equals(Buffer.alloc(32, 0))).toBe(false)

    const ledger = newLedger()
    ledger.commitments.add(hexEncode(note.commitment))

    const recipOwnerHash = computeOwnerHash(recipientSecret())
    const result = transferNote(ledger, note, secret, recipOwnerHash, nonce(2), 1_000n)

    expect('ok' in result).toBe(true)
    const transfer = (result as { ok: TokenTransfer }).ok
    expect(transfer.input_nullifier.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(transfer.output_commitment.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(transfer.transfer_proof.equals(Buffer.alloc(32, 0))).toBe(false)

    // nullifier recorded, original commitment consumed
    expect(ledger.nullifiers.size).toBe(1)
    expect(ledger.commitments.has(hexEncode(note.commitment))).toBe(false)
    expect(ledger.commitments.has(hexEncode(transfer.output_commitment))).toBe(true)
  })

  it('double spend: same nullifier rejected on second transfer', () => {
    const secret = ownerSecret()
    const note = mintNote(secret, 500n, nonce(1))

    const ledger = newLedger()
    ledger.commitments.add(hexEncode(note.commitment))

    const recipOwnerHash = computeOwnerHash(recipientSecret())

    // First transfer succeeds
    const first = transferNote(ledger, note, secret, recipOwnerHash, nonce(2), 500n)
    expect('ok' in first).toBe(true)

    // Attacker re-adds the original commitment to try to replay
    ledger.commitments.add(hexEncode(note.commitment))

    // Second transfer — nullifier already spent — must fail
    const second = transferNote(ledger, note, secret, recipOwnerHash, nonce(3), 500n)
    expect('err' in second).toBe(true)
    expect((second as { err: string }).err).toBe('NullifierAlreadySpent')
  })

  it('wrong owner secret: recomputed owner_hash mismatch detected', () => {
    const secret = ownerSecret()
    const note = mintNote(secret, 250n, nonce(1))

    const ledger = newLedger()
    ledger.commitments.add(hexEncode(note.commitment))

    // Slightly different secret — one byte flipped
    const wrongSecret = Buffer.from(secret)
    wrongSecret[1] = 0xff

    const recipOwnerHash = computeOwnerHash(recipientSecret())
    const result = transferNote(ledger, note, wrongSecret, recipOwnerHash, nonce(2), 250n)

    expect('err' in result).toBe(true)
    expect((result as { err: string }).err).toBe('OwnershipMismatch')
  })

  it('commitment not in ledger: transfer fails', () => {
    const secret = ownerSecret()
    const note = mintNote(secret, 100n, nonce(1))

    // Note intentionally not added to ledger
    const ledger = newLedger()

    const recipOwnerHash = computeOwnerHash(recipientSecret())
    const result = transferNote(ledger, note, secret, recipOwnerHash, nonce(2), 100n)

    expect('err' in result).toBe(true)
    expect((result as { err: string }).err).toBe('CommitmentNotFound')
  })

  it('output commitment becomes spendable — transfer output can be used in next transfer', () => {
    const secret = ownerSecret()
    const note = mintNote(secret, 800n, nonce(1))

    const ledger = newLedger()
    ledger.commitments.add(hexEncode(note.commitment))

    const recipSecret = recipientSecret()
    const recipOwnerHash = computeOwnerHash(recipSecret)

    // First transfer: original owner → recipient
    const first = transferNote(ledger, note, secret, recipOwnerHash, nonce(2), 800n)
    expect('ok' in first).toBe(true)
    const firstTransfer = (first as { ok: TokenTransfer }).ok

    // Build a TokenNote for the output so we can spend it
    const outputNote: TokenNote = {
      commitment: firstTransfer.output_commitment,
      owner_hash: recipOwnerHash,
    }

    // Second transfer: recipient → a third party
    const thirdPartyOwnerHash = computeOwnerHash(Buffer.from([0xaa, ...Array(31).fill(0)]))
    const second = transferNote(ledger, outputNote, recipSecret, thirdPartyOwnerHash, nonce(3), 800n)

    expect('ok' in second).toBe(true)
    const secondTransfer = (second as { ok: TokenTransfer }).ok
    expect(secondTransfer.transfer_proof.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(ledger.nullifiers.size).toBe(2)
  })

  it('ledger record shape — has commitment_count, nullifier_count; no individual commitments', () => {
    const secret = ownerSecret()
    const note1 = mintNote(secret, 777n, nonce(1))
    const note2 = mintNote(secret, 888n, nonce(2))

    const ledger = newLedger()
    ledger.commitments.add(hexEncode(note1.commitment))
    ledger.commitments.add(hexEncode(note2.commitment))

    const recipOwnerHash = computeOwnerHash(recipientSecret())
    transferNote(ledger, note1, secret, recipOwnerHash, nonce(3), 777n)

    const record = ledgerPublicRecord(ledger)
    const recordJson = JSON.stringify(record)

    // Required aggregate fields
    expect(typeof record.commitment_count).toBe('number')
    expect(typeof record.nullifier_count).toBe('number')
    expect(record.nullifier_count).toBe(1)

    // Individual commitment hex values must NOT appear in the record
    expect(recordJson).not.toContain(hexEncode(note1.commitment))
    expect(recordJson).not.toContain(hexEncode(note2.commitment))
    expect(Object.keys(record)).not.toContain('commitments')
    expect(Object.keys(record)).not.toContain('nullifiers')
  })
})
