/**
 * receipt-dag — Anti-equivocation DAG for x402 agent receipts.
 *
 * Core guarantee: two receipts from the same agent with the same sequenceNonce
 * is cryptographic proof of cheating. The DAG makes history append-only and
 * tamper-evident by chaining each receipt to its parent via its receiptId.
 *
 * Properties:
 *  - APPEND-ONLY: each receipt links to its predecessor (parentReceiptId).
 *  - TAMPER-EVIDENT: actionHash = SHA-256(action/result payload).
 *  - ANTI-EQUIVOCATION: (agentPubkey, sequenceNonce) must be globally unique.
 *  - ANCHORED: batch Merkle root committed on Solana via receipt_anchor program.
 */

import { createHash } from "node:crypto";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single node in the receipt DAG. */
export interface DagReceipt {
  /** Unique identifier for this receipt: SHA-256(agentPubkey + sequenceNonce + actionHash). */
  receiptId: string;
  /** receiptId of the previous receipt from this agent. Absent for the genesis receipt. */
  parentReceiptId?: string;
  /**
   * Monotonically increasing counter per (agentPubkey).
   * A duplicate (agentPubkey, sequenceNonce) pair is proof of equivocation.
   */
  sequenceNonce: number;
  /** Base-58 or hex-encoded public key of the agent that produced this receipt. */
  agentPubkey: string;
  /** SHA-256 hex digest of the action payload / result this receipt covers. */
  actionHash: string;
  /** Unix timestamp (ms) when the receipt was created. */
  timestamp: number;
  /** Solana transaction signature if this receipt (or its batch) was anchored. */
  solanaTx?: string;
}

/** Returned by verifyDagChain — pass=true means chain is valid. */
export interface DagVerifyResult {
  valid: boolean;
  /** Human-readable description of the first violation found, if any. */
  violation?: string;
  /** The two receipts that caused an equivocation violation, if detected. */
  equivocationEvidence?: [DagReceipt, DagReceipt];
}

/** Parameters for buildDagReceipt. */
export interface BuildDagReceiptParams {
  agentPubkey: string;
  actionHash: string;
  sequenceNonce: number;
  parentReceiptId?: string;
  timestamp?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function sha256buf(data: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Derive the canonical receiptId from its immutable fields.
 * receiptId = SHA-256(agentPubkey || ":" || sequenceNonce || ":" || actionHash)
 */
function deriveReceiptId(
  agentPubkey: string,
  sequenceNonce: number,
  actionHash: string
): string {
  return sha256hex(`${agentPubkey}:${sequenceNonce}:${actionHash}`);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a new DagReceipt that links to its parent.
 *
 * @param params.agentPubkey   - The agent's public key.
 * @param params.actionHash    - SHA-256 of the action/result being receipted.
 * @param params.sequenceNonce - Must be exactly (parent.sequenceNonce + 1) or 0 for genesis.
 * @param params.parentReceiptId - receiptId of the previous receipt; omit for genesis.
 * @param params.timestamp     - Unix ms; defaults to Date.now().
 */
export function buildDagReceipt(params: BuildDagReceiptParams): DagReceipt {
  const {
    agentPubkey,
    actionHash,
    sequenceNonce,
    parentReceiptId,
    timestamp = Date.now(),
  } = params;

  if (sequenceNonce < 0 || !Number.isInteger(sequenceNonce)) {
    throw new RangeError(`sequenceNonce must be a non-negative integer, got ${sequenceNonce}`);
  }
  if (sequenceNonce === 0 && parentReceiptId !== undefined) {
    throw new Error("Genesis receipt (sequenceNonce=0) must not have a parentReceiptId");
  }
  if (sequenceNonce > 0 && parentReceiptId === undefined) {
    throw new Error(`Non-genesis receipt (sequenceNonce=${sequenceNonce}) requires a parentReceiptId`);
  }

  const receiptId = deriveReceiptId(agentPubkey, sequenceNonce, actionHash);

  const receipt: DagReceipt = {
    receiptId,
    sequenceNonce,
    agentPubkey,
    actionHash,
    timestamp,
  };
  if (parentReceiptId !== undefined) {
    receipt.parentReceiptId = parentReceiptId;
  }
  return receipt;
}

/**
 * Verify a set of DagReceipts for chain integrity and anti-equivocation.
 *
 * Rules checked:
 *  1. receiptId integrity — each receiptId must match its derived value.
 *  2. Anti-equivocation — no two receipts from the same agent share a sequenceNonce.
 *  3. Parent linkage — each non-genesis receipt's parentReceiptId must refer to a
 *     receipt that exists in the provided set with (sequenceNonce - 1).
 *  4. Monotonicity — per-agent nonces must strictly increase (no gaps enforced
 *     within a partial batch, but ordering within the set is validated).
 *
 * NOTE: receipts need not be sorted; the function handles unordered batches.
 */
export function verifyDagChain(receipts: DagReceipt[]): DagVerifyResult {
  // Index by receiptId for O(1) parent lookups.
  const byId = new Map<string, DagReceipt>();
  // Track seen (agentPubkey, sequenceNonce) pairs for equivocation detection.
  const seen = new Map<string, DagReceipt>();

  for (const r of receipts) {
    // ── Rule 1: receiptId integrity ──────────────────────────────────────────
    const expected = deriveReceiptId(r.agentPubkey, r.sequenceNonce, r.actionHash);
    if (r.receiptId !== expected) {
      return {
        valid: false,
        violation: `receiptId mismatch for agent=${r.agentPubkey} nonce=${r.sequenceNonce}: ` +
          `stored=${r.receiptId} expected=${expected}`,
      };
    }

    // ── Rule 2: anti-equivocation ─────────────────────────────────────────────
    const key = `${r.agentPubkey}:${r.sequenceNonce}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      return {
        valid: false,
        violation: `EQUIVOCATION DETECTED — agent=${r.agentPubkey} has two receipts with sequenceNonce=${r.sequenceNonce}`,
        equivocationEvidence: [prior, r],
      };
    }
    seen.set(key, r);
    byId.set(r.receiptId, r);
  }

  // ── Rule 3 & 4: parent linkage and nonce monotonicity ────────────────────────
  for (const r of receipts) {
    if (r.sequenceNonce === 0) {
      // Genesis: must have no parent.
      if (r.parentReceiptId !== undefined) {
        return {
          valid: false,
          violation: `Genesis receipt (nonce=0) for agent=${r.agentPubkey} must not have a parentReceiptId`,
        };
      }
      continue;
    }

    // Non-genesis: parent must be declared.
    if (r.parentReceiptId === undefined) {
      return {
        valid: false,
        violation: `Receipt nonce=${r.sequenceNonce} from agent=${r.agentPubkey} is missing parentReceiptId`,
      };
    }

    // If the parent is also in this batch, verify the link.
    const parent = byId.get(r.parentReceiptId);
    if (parent !== undefined) {
      if (parent.agentPubkey !== r.agentPubkey) {
        return {
          valid: false,
          violation: `Receipt nonce=${r.sequenceNonce} from agent=${r.agentPubkey} links to a receipt ` +
            `belonging to a different agent=${parent.agentPubkey}`,
        };
      }
      if (parent.sequenceNonce !== r.sequenceNonce - 1) {
        return {
          valid: false,
          violation: `Nonce discontinuity for agent=${r.agentPubkey}: ` +
            `receipt nonce=${r.sequenceNonce} links to parent nonce=${parent.sequenceNonce} (expected ${r.sequenceNonce - 1})`,
        };
      }
    }
    // If the parent is NOT in this batch (cross-batch reference), we accept the
    // declared parentReceiptId at face value; full chain verification would require
    // fetching the prior batch from the archive.
  }

  return { valid: true };
}

// ── Merkle root + Solana anchoring ─────────────────────────────────────────────

/** The receipt_anchor program on Solana mainnet-beta. */
export const RECEIPT_ANCHOR_PROGRAM_ID = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";

/**
 * Build a Merkle root over a DAG receipt batch.
 *
 * Each leaf = SHA-256(JSON.stringify(receipt)).
 * Internal nodes = SHA-256(left || right).
 * Uses a streaming O(log N) algorithm: safe for arbitrarily large batches.
 *
 * @returns 32-byte Buffer containing the Merkle root.
 */
export function buildDagMerkleRoot(receipts: DagReceipt[]): Buffer {
  if (receipts.length === 0) return Buffer.alloc(32, 0);

  // Streaming Merkle: keep only O(log N) nodes in memory.
  const stack: (Buffer | null)[] = [];

  function pushLeaf(leaf: Buffer): void {
    let carry = leaf;
    for (let level = 0; level < stack.length; level++) {
      const pending = stack[level];
      if (pending === null) {
        stack[level] = carry;
        return;
      }
      carry = sha256buf(Buffer.concat([pending, carry]));
      stack[level] = null;
    }
    stack.push(carry);
  }

  for (const r of receipts) {
    const leaf = sha256buf(Buffer.from(JSON.stringify(r), "utf8"));
    pushLeaf(leaf);
  }

  // Finalise: combine remaining nodes from lowest level upward.
  let carry: Buffer | null = null;
  for (let i = 0; i < stack.length; i++) {
    const node = stack[i];
    if (node === null) continue;
    carry = carry === null ? node : sha256buf(Buffer.concat([node, carry]));
  }
  return carry ?? Buffer.alloc(32, 0);
}

/**
 * Anchor a DAG receipt batch on Solana.
 *
 * Builds the Merkle root of the batch, then submits a transaction to the
 * receipt_anchor program (same program used by liquefy-receipts) so the root
 * is immutably recorded on-chain. Returns the transaction signature.
 *
 * Instruction data layout: [0x01][0x00][32 bytes root]  (34 bytes total)
 *
 * @param receipts   - The batch of DagReceipts to anchor.
 * @param connection - A @solana/web3.js Connection to an RPC endpoint.
 * @param payer      - The fee-payer Keypair that signs the transaction.
 * @returns Solana transaction signature (base-58 string).
 */
export async function anchorDagRoot(
  receipts: DagReceipt[],
  connection: Connection,
  payer: Keypair
): Promise<string> {
  // Dynamic import so the package stays importable in environments that do not
  // have @solana/web3.js installed (e.g. pure-Node unit tests).
  const { Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } =
    await import("@solana/web3.js");

  if (receipts.length === 0) {
    throw new Error("Cannot anchor an empty receipt batch");
  }

  const root = buildDagMerkleRoot(receipts);

  // Build anchor instruction data: [0x01][0x00][32-byte root]
  const ixData = new Uint8Array(34);
  ixData[0] = 0x01;
  ixData[1] = 0x00;
  ixData.set(root, 2);

  const programId = new PublicKey(RECEIPT_ANCHOR_PROGRAM_ID);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  return sig;
}

// ── Convenience re-exports ────────────────────────────────────────────────────

/**
 * Compute the SHA-256 of an arbitrary action payload (stringified or raw).
 * Pass the result as `actionHash` when building a DagReceipt.
 */
export function hashAction(action: unknown): string {
  const data = typeof action === "string" ? action : JSON.stringify(action);
  return sha256hex(data);
}
