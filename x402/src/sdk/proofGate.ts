/**
 * TypeScript client for dark_proof_gate_lite — on-chain claim registry.
 *
 * Records externally-verified claims as on-chain PDAs so the proof trail is
 * auditable without trusting any database.  Not a ZK verifier — the program
 * stores that the claim was verified off-chain and is now anchored.
 *
 * StatementKind bytes (match programs/dark_proof_gate_lite/src/lib.rs):
 *   0x10 ReceiptRedeem         — payment receipt claimed for service delivery
 *   0x11 SessionNetSettlement  — multi-turn session settled net
 *   0x12 ModelOutputBound      — model output committed at fixed price
 *   0x13 NullifierNotReused    — ZK nullifier confirmed not replayed
 *   0x14 ApiMeterBurn          — API call budget consumed (ZK budget compliance)
 *   0x15 PredictionCommitReveal — prediction committed and later revealed
 *
 * Usage:
 *   const client = new ProofGateClient(connection, new PublicKey(process.env.PROOF_GATE_PROGRAM_ID!));
 *   const result = await client.recordClaim(payer, claimHash, STATEMENT_KIND.RECEIPT_REDEEM);
 */

import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ── Statement kind constants ───────────────────────────────────────────────────

export const STATEMENT_KIND = {
  RECEIPT_REDEEM: 0x10,
  SESSION_NET_SETTLEMENT: 0x11,
  MODEL_OUTPUT_BOUND: 0x12,
  NULLIFIER_NOT_REUSED: 0x13,
  API_METER_BURN: 0x14,
  PREDICTION_COMMIT_REVEAL: 0x15,
} as const satisfies Record<string, number>;

export type StatementKind = (typeof STATEMENT_KIND)[keyof typeof STATEMENT_KIND];

export const CLAIM_RECORD_LEN = 74; // bump(1) + claim_hash(32) + authority(32) + kind(1) + slot(8)

// ── Pure data types ────────────────────────────────────────────────────────────

export interface ClaimRecord {
  bump: number;
  claimHash: Uint8Array;
  authority: PublicKey;
  statementKind: number;
  recordedAtSlot: bigint;
}

export interface RecordClaimResult {
  txSignature: string;
  claimPda: PublicKey;
  bump: number;
}

// ── PDA derivation ─────────────────────────────────────────────────────────────

/**
 * Derive the claim PDA for a given hash + authority.
 * Seeds: ["claim", claimHash (32 bytes), authority pubkey (32 bytes)]
 */
export function getClaimPda(
  claimHash: Uint8Array,
  authority: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  if (claimHash.length !== 32) {
    throw new Error(`claimHash must be exactly 32 bytes, got ${claimHash.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), Buffer.from(claimHash), authority.toBuffer()],
    programId,
  );
}

// ── Hash helpers ───────────────────────────────────────────────────────────────

/**
 * Hash a receipt payload into a 32-byte claim hash.
 * Keys are sorted for canonical encoding.
 */
export function hashReceiptPayload(payload: Record<string, unknown>): Uint8Array {
  const sorted = Object.fromEntries(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return new Uint8Array(
    crypto.createHash("sha256").update(JSON.stringify(sorted)).digest(),
  );
}

/**
 * Hash any string (tx signature, stream ID, memo, etc.) into a 32-byte claim hash.
 */
export function hashString(input: string): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(input, "utf8").digest());
}

/**
 * Hash raw bytes into a 32-byte claim hash.
 */
export function hashBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(input).digest());
}

// ── Instruction encoding ───────────────────────────────────────────────────────

/**
 * Build the RecordVerifiedClaim instruction data buffer (34 bytes).
 *   byte 0     — discriminant = 0 (RecordVerifiedClaim)
 *   bytes 1-32 — claim_hash
 *   byte 33    — statement_kind
 */
export function buildRecordClaimData(
  claimHash: Uint8Array,
  statementKind: number,
): Buffer {
  if (claimHash.length !== 32) {
    throw new Error(`claimHash must be 32 bytes, got ${claimHash.length}`);
  }
  if (statementKind < 0x10 || statementKind > 0x15) {
    throw new Error(`statementKind 0x${statementKind.toString(16)} out of valid range 0x10-0x15`);
  }
  const buf = Buffer.alloc(34);
  buf[0] = 0x00; // RecordVerifiedClaim discriminant
  Buffer.from(claimHash).copy(buf, 1);
  buf[33] = statementKind & 0xff;
  return buf;
}

// ── Account decoding ───────────────────────────────────────────────────────────

/**
 * Decode a ClaimRecord from raw account data.
 * Returns null if the buffer is too short or uninitialized.
 */
export function decodeClaimRecord(data: Buffer | Uint8Array): ClaimRecord | null {
  if (data.length < CLAIM_RECORD_LEN) {
    return null;
  }
  const buf = Buffer.from(data);
  const bump = buf[0];
  const claimHash = new Uint8Array(buf.slice(1, 33));
  const authorityBytes = new Uint8Array(buf.slice(33, 65));
  const statementKind = buf[65];
  const recordedAtSlot = buf.readBigUInt64LE(66);
  return {
    bump,
    claimHash,
    authority: new PublicKey(authorityBytes),
    statementKind,
    recordedAtSlot,
  };
}

// ── ProofGateClient ────────────────────────────────────────────────────────────

export class ProofGateClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey,
  ) {}

  /**
   * Submit a RecordVerifiedClaim transaction.
   *
   * Accounts (matches programs/dark_proof_gate_lite/src/lib.rs processor):
   *   0. claim_record_pda (writable, new) — derived, no data yet
   *   1. authority          (signer)
   *   2. system_program
   *
   * @param payer     Pays transaction fees and funds the PDA rent.
   * @param claimHash 32-byte hash identifying the claim.
   * @param kind      StatementKind byte (use STATEMENT_KIND constants).
   * @param authority Optional separate authority if different from payer.
   */
  async recordClaim(
    payer: Keypair,
    claimHash: Uint8Array,
    kind: StatementKind,
    authority?: Keypair,
  ): Promise<RecordClaimResult> {
    const auth = authority ?? payer;
    const [claimPda, bump] = getClaimPda(claimHash, auth.publicKey, this.programId);
    const data = buildRecordClaimData(claimHash, kind);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: claimPda, isSigner: false, isWritable: true },
        { pubkey: auth.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const signers: Keypair[] = [payer];
    if (authority && authority.publicKey.toString() !== payer.publicKey.toString()) {
      signers.push(authority);
    }

    const tx = new Transaction().add(ix);
    const txSignature = await sendAndConfirmTransaction(this.connection, tx, signers);

    return { txSignature, claimPda, bump };
  }

  /**
   * Check whether a claim PDA exists on-chain.
   * Returns the decoded record, or null if not found.
   */
  async fetchClaim(
    claimHash: Uint8Array,
    authority: PublicKey,
  ): Promise<ClaimRecord | null> {
    const [claimPda] = getClaimPda(claimHash, authority, this.programId);
    const accountInfo = await this.connection.getAccountInfo(claimPda);
    if (!accountInfo || accountInfo.data.length === 0) {
      return null;
    }
    return decodeClaimRecord(accountInfo.data);
  }

  /**
   * Shortcut: anchor a payment receipt by its receiptId and settlement signature.
   * Hashes `${receiptId}:${txSignature}` → 32-byte claim hash, records as RECEIPT_REDEEM.
   */
  async anchorReceipt(
    payer: Keypair,
    receiptId: string,
    txSignature: string,
  ): Promise<RecordClaimResult> {
    const claimHash = hashString(`${receiptId}:${txSignature}`);
    return this.recordClaim(payer, claimHash, STATEMENT_KIND.RECEIPT_REDEEM);
  }

  /**
   * Shortcut: record an API meter burn for ZK budget compliance.
   * Hashes `api_burn:${sessionId}:${usedAtomic}:${budgetAtomic}`.
   */
  async recordApiBurn(
    payer: Keypair,
    sessionId: string,
    usedAtomic: string,
    budgetAtomic: string,
  ): Promise<RecordClaimResult> {
    const claimHash = hashString(`api_burn:${sessionId}:${usedAtomic}:${budgetAtomic}`);
    return this.recordClaim(payer, claimHash, STATEMENT_KIND.API_METER_BURN);
  }
}
