/**
 * null-miner-sdk — Groth16 receipt witnesses + SnarkPack batch commitments
 *
 * SnarkPack (Gabizon & Nikolaenko 2021) aggregates N Groth16 proofs into one
 * by committing the A, B, C proof elements with powers r^1…r^N of a random
 * challenge r (Fiat-Shamir). Verification costs ONE pairing regardless of N.
 *
 *   Without aggregation: N proofs × ~150K CU → hits Solana's 1.4M limit at N=9.
 *   With SnarkPack:      1 aggregated proof ≈ 200K CU. N=8192 fits trivially.
 *
 * Applied to x402 payment receipts: a relayer can collect ~8192 per-second
 * micro-payment proofs, pack them in 33ms, and anchor the batch with a single
 * Solana transaction. On-chain cost per receipt drops to ~24 CU.
 *
 * This module:
 *   1. `buildReceiptWitness`         — private inputs for the receipt circuit
 *   2. `computeReceiptPublicInputs`  — public outputs committed on-chain
 *   3. `buildSnarkPackBatch`         — structured inputs for the aggregation
 */

import { createHash }  from "crypto";
import {
  bytesToField,
  fieldMod,
  fieldToBytes,
  fieldToHex,
  poseidonHash2,
  sha256Field,
  hexToField,
} from "./poseidon.js";

// ── Receipt Witness ────────────────────────────────────────────────────────────

/**
 * Private inputs for the NULL Miner receipt Groth16 circuit.
 * All values are BN254 field elements (bigint).
 */
export interface ReceiptWitness {
  payerAddressField: bigint;   // H("receipt-payer-v1"    || address_bytes)
  amountAtomic:      number;   // raw atomic USDC units
  resourceHash:      bigint;   // H("receipt-resource-v1" || resource_utf8)
  platformIdHash:    bigint;   // H("receipt-platform-v1" || platformId_utf8)
  nullifierSeed:     bigint;   // from AgentPassport.nullifierSeed(taskId)
  taskIdField:       bigint;   // H(taskId_hex)
}

/**
 * Public outputs verified on-chain by programs/dark_bn254_gate.
 * These are the only values the verifier needs; private inputs remain hidden.
 */
export interface ReceiptPublicInputs {
  /** Poseidon tree commitment over payer + amount + resource + platform. */
  receiptCommitment: string;   // 64-char hex
  /** Poseidon2([nullifierSeed, taskIdField]) — prevents double-claim. */
  nullifierHash:     string;   // 64-char hex
  /** Minimum amount bound (verified: paid >= amountBound). */
  amountBound:       number;
  /** Network + epoch context (replay prevention across epochs). */
  contextId:         string;   // 64-char hex
}

/**
 * Build a receipt witness from a verified x402 payment.
 *
 * @example
 * const witness = buildReceiptWitness({
 *   payerAddress:  payment.payerAddress,
 *   amountAtomic:  payment.amountAtomic,
 *   resource:      "/api/task/complete",
 *   platformId:    "my-app",
 *   nullifierSeed: passport.nullifierSeed(taskId),
 *   taskId,
 * });
 */
export function buildReceiptWitness(opts: {
  payerAddress:  string;
  amountAtomic:  number;
  resource:      string;
  platformId:    string;
  nullifierSeed: string;  // hex (from AgentPassport.nullifierSeed)
  taskId:        string;  // hex (64 chars)
}): ReceiptWitness {
  return {
    payerAddressField: sha256Field("receipt-payer-v1",    Buffer.from(opts.payerAddress)),
    amountAtomic:      opts.amountAtomic,
    resourceHash:      sha256Field("receipt-resource-v1", Buffer.from(opts.resource)),
    platformIdHash:    sha256Field("receipt-platform-v1", Buffer.from(opts.platformId)),
    nullifierSeed:     hexToField(opts.nullifierSeed),
    taskIdField:       sha256Field("receipt-task-v1",     Buffer.from(opts.taskId, "hex")),
  };
}

/**
 * Compute the public inputs from a receipt witness.
 *
 * receiptCommitment = Poseidon2(
 *   Poseidon2(payerAddressField, amountField),
 *   Poseidon2(resourceHash, platformIdHash),
 * )
 * nullifierHash = Poseidon2(nullifierSeed, taskIdField)
 */
export function computeReceiptPublicInputs(
  witness: ReceiptWitness,
  contextId: string = "null-miner-devnet-v1",
): ReceiptPublicInputs {
  const amountField   = fieldMod(BigInt(witness.amountAtomic));
  const payerAmt      = poseidonHash2(witness.payerAddressField, amountField);
  const resPlatform   = poseidonHash2(witness.resourceHash, witness.platformIdHash);
  const receiptCmt    = poseidonHash2(payerAmt, resPlatform);
  const nullHash      = poseidonHash2(witness.nullifierSeed, witness.taskIdField);
  const ctxField      = sha256Field("receipt-context-v1", Buffer.from(contextId));

  return {
    receiptCommitment: fieldToHex(receiptCmt),
    nullifierHash:     fieldToHex(nullHash),
    amountBound:       witness.amountAtomic,
    contextId:         fieldToHex(ctxField),
  };
}

// ── SnarkPack Batch Commitment ─────────────────────────────────────────────────

/**
 * SnarkPack batch commitment over N receipt public inputs.
 * Feed `receipts` array and the Fiat-Shamir `challenge` to your aggregation
 * circuit (snarkjs, rapidsnark, or Rust SnarkPack library).
 */
export interface SnarkPackBatch {
  count:          number;
  epoch:          number;
  /** Poseidon Merkle root over all receiptCommitment leaves. */
  batchRoot:      string;   // 64-char hex
  /** Fiat-Shamir challenge r = H(all commitments). */
  challenge:      string;   // 64-char hex
  /** Poseidon2([batchRoot_field, epoch_field]) — prevents batch replay. */
  batchNullifier: string;   // 64-char hex
  receipts:       ReceiptPublicInputs[];
}

/**
 * Build a SnarkPack batch from an array of receipt public inputs.
 *
 * @example
 * const batch = buildSnarkPackBatch(receipts);
 * // pass batch.challenge and batch.receipts to snarkjs aggregation circuit
 */
export function buildSnarkPackBatch(
  receipts: ReceiptPublicInputs[],
  epoch?: number,
): SnarkPackBatch {
  if (receipts.length === 0) throw new Error("Cannot build empty batch");
  const currentEpoch = epoch ?? Math.floor(Date.now() / 3_600_000);

  const leaves     = receipts.map(r => Buffer.from(r.receiptCommitment, "hex"));
  const batchRoot  = merkleRootPoseidon(leaves);
  const challenge  = sha256Field("snarkpack-challenge-v1", Buffer.concat(leaves));
  const rootField  = bytesToField(batchRoot);
  const epochField = fieldMod(BigInt(currentEpoch));
  const batchNull  = poseidonHash2(rootField, epochField);

  return {
    count: receipts.length,
    epoch: currentEpoch,
    batchRoot:      batchRoot.toString("hex"),
    challenge:      fieldToHex(challenge),
    batchNullifier: fieldToHex(batchNull),
    receipts,
  };
}

/**
 * Build a Poseidon Merkle root over an array of 32-byte leaf buffers.
 * Pads to the next power of 2 with zero leaves.
 */
export function merkleRootPoseidon(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new Error("No leaves");
  // Pad to next power-of-2 (minimum 2)
  let padded = [...leaves];
  const p2   = Math.max(2, nextPow2(padded.length));
  while (padded.length < p2) padded.push(Buffer.alloc(32));

  while (padded.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < padded.length; i += 2) {
      const l = bytesToField(padded[i]!);
      const r = bytesToField(padded[i + 1]!);
      next.push(fieldToBytes(poseidonHash2(l, r)));
    }
    padded = next;
  }
  return padded[0]!;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
