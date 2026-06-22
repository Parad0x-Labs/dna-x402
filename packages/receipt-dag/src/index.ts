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

/**
 * The stack layer a receipt was produced by. The DAG spans layers: an agent's actions
 * chain by sequenceNonce (parentReceiptId), and a receipt may ADDITIONALLY depend on
 * receipts in OTHER layers via `crossRefs` (e.g. an x402 access grant depends on the
 * payment that funded it). Chain edges + cross-layer edges together form the graph.
 */
export type ReceiptLayer =
  | "payment"
  | "x402-access"
  | "shielded"
  | "reputation"
  | "job";

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
  /** Which stack layer produced this receipt (the layer builders fold it into actionHash). */
  layer?: ReceiptLayer;
  /**
   * receiptIds in OTHER layers/agents this receipt depends on — the cross-layer graph
   * edges (e.g. an x402-access receipt cross-refs the payment receipt that funded it).
   * Distinct from `parentReceiptId` (the same-agent monotonic chain). Bound into the
   * anchored Merkle root (which hashes the whole receipt), so they are tamper-evident.
   */
  crossRefs?: string[];
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
  /** Which stack layer produced this receipt. */
  layer?: ReceiptLayer;
  /** receiptIds in other layers/agents this receipt depends on (cross-layer graph edges). */
  crossRefs?: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function sha256buf(data: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

// RFC-6962 §2.1 domain separation for the batch Merkle tree: leaves are hashed
// with a 0x00 prefix and internal nodes with a 0x01 prefix, so a leaf hash can
// never be presented as an internal node (or vice-versa) to forge an inclusion
// proof — the second-preimage attack.
const LEAF_PREFIX     = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

/** RFC-6962 leaf hash: SHA-256(0x00 || data). */
function hashLeafBytes(data: Buffer | Uint8Array): Buffer {
  return sha256buf(Buffer.concat([LEAF_PREFIX, data]));
}

/** RFC-6962 internal-node hash: SHA-256(0x01 || left || right). */
function hashInternal(left: Buffer, right: Buffer): Buffer {
  return sha256buf(Buffer.concat([INTERNAL_PREFIX, left, right]));
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
    layer,
    crossRefs,
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

  if (crossRefs?.some((ref) => ref === receiptId)) {
    throw new Error("A receipt cannot cross-reference itself");
  }

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
  if (layer !== undefined) {
    receipt.layer = layer;
  }
  if (crossRefs !== undefined && crossRefs.length > 0) {
    receipt.crossRefs = [...crossRefs];
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

  // ── Rule 5: cross-layer edges resolve + the parent+crossRef graph is acyclic ──
  // crossRefs are the inter-layer dependency edges (e.g. x402-access → payment). A
  // self-reference, or a cycle in the combined parent+crossRef graph, would let a
  // receipt claim to depend on its own descendant — reject both.
  for (const r of receipts) {
    for (const ref of r.crossRefs ?? []) {
      if (ref === r.receiptId) {
        return { valid: false, violation: `Receipt ${r.receiptId} cross-references itself` };
      }
      // Cross-batch refs (not present in this batch) are accepted at face value, like parents.
    }
  }
  // Iterative DFS cycle detection over within-batch parent + crossRef edges.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const r of receipts) color.set(r.receiptId, WHITE);
  const edgesOf = (r: DagReceipt): string[] => {
    const out: string[] = [];
    if (r.parentReceiptId !== undefined && byId.has(r.parentReceiptId)) out.push(r.parentReceiptId);
    for (const ref of r.crossRefs ?? []) if (byId.has(ref)) out.push(ref);
    return out;
  };
  for (const root of receipts) {
    if (color.get(root.receiptId) !== WHITE) continue;
    const stack: Array<{ id: string; it: number }> = [{ id: root.receiptId, it: 0 }];
    color.set(root.receiptId, GREY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = byId.get(top.id);
      const out = node ? edgesOf(node) : [];
      if (top.it < out.length) {
        const next = out[top.it++];
        const c = color.get(next);
        if (c === GREY) {
          return { valid: false, violation: `Cycle in the cross-layer graph at ${next}` };
        }
        if (c === WHITE) {
          color.set(next, GREY);
          stack.push({ id: next, it: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }

  return { valid: true };
}

// ── Merkle root + Solana anchoring ─────────────────────────────────────────────

/** The receipt_anchor program on Solana mainnet-beta. */
export const RECEIPT_ANCHOR_PROGRAM_ID = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";

/**
 * Build a Merkle root over a DAG receipt batch.
 *
 * Hashing is domain-separated per RFC-6962 §2.1 (blocks second-preimage forgery):
 *   leaf hash     = SHA-256(0x00 || JSON.stringify(receipt))
 *   internal node = SHA-256(0x01 || left || right)
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
      carry = hashInternal(pending, carry);
      stack[level] = null;
    }
    stack.push(carry);
  }

  for (const r of receipts) {
    const leaf = hashLeafBytes(Buffer.from(JSON.stringify(r), "utf8"));
    pushLeaf(leaf);
  }

  // Finalise: combine remaining nodes from lowest level upward.
  let carry: Buffer | null = null;
  for (let i = 0; i < stack.length; i++) {
    const node = stack[i];
    if (node === null) continue;
    carry = carry === null ? node : hashInternal(node, carry);
  }
  return carry ?? Buffer.alloc(32, 0);
}

/** PDA seed prefix for a receipt_anchor bucket account. */
export const RECEIPT_ANCHOR_BUCKET_SEED = "bucket";
/** The program's bucket window (seconds); its default bucket_id is floor(unix/3600). */
export const RECEIPT_ANCHOR_BUCKET_WINDOW_SECONDS = 3600;

export interface AnchorDagRootOptions {
  /** Anchor program id. Defaults to the mainnet program; pass a devnet id to anchor on devnet. */
  programId?: string;
  /**
   * Explicit bucket id (the program accumulates each anchor into a per-bucket running root).
   * Defaults to floor(Date.now()/1000/3600), matching the program's own default bucket.
   */
  bucketId?: bigint;
}

export interface AnchorDagRootResult {
  signature: string;
  /** The cross-layer Merkle root that was anchored (hex). */
  anchor: string;
  /** The bucket id the anchor was folded into. */
  bucketId: bigint;
  /** The bucket PDA whose running root + count were updated. */
  bucketPda: string;
}

/**
 * Anchor a DAG receipt batch on Solana via the `receipt_anchor` program.
 *
 * Builds the batch Merkle root and folds it into a bucket's running root on-chain:
 * `bucket.root = SHA-256(bucket.root || anchor)`, `bucket.count += 1`. The bucket is a
 * PDA `["bucket", bucket_id_le]` created on first use. Uses the AnchorSingle wire form
 * with an explicit bucket id: `[version=1][flags=0x01][root32][bucket_id_le8]` (42 bytes),
 * accounts `[payer(signer,writable), bucket(writable), system_program]`.
 *
 * @returns the tx signature plus the anchored root, bucket id, and bucket PDA (so callers
 *          can read the bucket account back and verify the accumulation).
 */
export async function anchorDagRoot(
  receipts: DagReceipt[],
  connection: Connection,
  payer: Keypair,
  options: AnchorDagRootOptions = {}
): Promise<AnchorDagRootResult> {
  // Dynamic import so the package stays importable in environments without @solana/web3.js.
  const { Transaction, TransactionInstruction, PublicKey, SystemProgram, sendAndConfirmTransaction } =
    await import("@solana/web3.js");

  if (receipts.length === 0) {
    throw new Error("Cannot anchor an empty receipt batch");
  }

  const programId = new PublicKey(options.programId ?? RECEIPT_ANCHOR_PROGRAM_ID);
  const bucketId =
    options.bucketId ??
    BigInt(Math.floor(Date.now() / 1000 / RECEIPT_ANCHOR_BUCKET_WINDOW_SECONDS));

  const root = buildDagMerkleRoot(receipts);

  const bucketIdLe = Buffer.alloc(8);
  bucketIdLe.writeBigUInt64LE(bucketId);
  const [bucketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(RECEIPT_ANCHOR_BUCKET_SEED), bucketIdLe],
    programId
  );

  // AnchorSingle with explicit bucket: [version=1][flags=FLAG_HAS_BUCKET_ID=0x01][root32][bucket_id_le8].
  const data = Buffer.concat([Buffer.from([0x01, 0x01]), root, bucketIdLe]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bucketPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
  return { signature, anchor: root.toString("hex"), bucketId, bucketPda: bucketPda.toBase58() };
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

// ── Cross-layer integration ──────────────────────────────────────────────────────

/** Parameters for buildX402AccessReceipt. */
export interface BuildX402AccessReceiptParams {
  /** The agent identity (e.g. the on-chain agent_commitment as a hex/decimal string). */
  agentPubkey: string;
  /** BN254-Fr scope hash the x402 access proof was bound to. */
  scopeHash: string;
  /** Rate-limit epoch the proof was bound to. */
  epoch: number | string;
  /** The single-use access nullifier recorded on-chain by the gate. */
  nullifier: string;
  /** receiptId of the settlement/payment that funded this access (the cross-layer edge). */
  fundingReceiptId: string;
  /** The agent's global monotonic sequence number across all layers. */
  sequenceNonce: number;
  /** receiptId of this agent's previous action (any layer); omit only for genesis. */
  parentReceiptId?: string;
  timestamp?: number;
}

/**
 * Build a DagReceipt for an x402 access grant produced by the Merkle-bound access gate
 * (`dark_x402_access_gate` v2). The `actionHash` binds the access semantics (scope,
 * epoch, nullifier); `parentReceiptId` continues this agent's chain; and `crossRefs`
 * records the funding payment — so the graph can prove "this access was backed by a
 * settled payment" without revealing amounts or counterparties.
 *
 * The two anti-abuse mechanisms compose: the on-chain nullifier stops *replay* of one
 * access, and the DAG's anti-equivocation stops the agent claiming two *histories*.
 */
export function buildX402AccessReceipt(params: BuildX402AccessReceiptParams): DagReceipt {
  const {
    agentPubkey, scopeHash, epoch, nullifier,
    fundingReceiptId, sequenceNonce, parentReceiptId, timestamp,
  } = params;
  const actionHash = hashAction({ layer: "x402-access", scopeHash, epoch: String(epoch), nullifier });
  return buildDagReceipt({
    agentPubkey,
    actionHash,
    sequenceNonce,
    parentReceiptId,
    timestamp,
    layer: "x402-access",
    crossRefs: [fundingReceiptId],
  });
}

/**
 * Walk a receipt's full provenance — every ancestor reachable via parent + crossRef
 * edges within the batch — so a cross-layer claim can be proven, e.g. that an
 * x402-access receipt traces back to a `payment` (or `shielded`) receipt.
 *
 * @returns the ancestor receipts (excluding the start) and the set of layers reached.
 */
export function traceProvenance(
  startReceiptId: string,
  receipts: DagReceipt[]
): { ancestors: DagReceipt[]; reachedLayers: Set<ReceiptLayer> } {
  const byId = new Map(receipts.map((r) => [r.receiptId, r] as const));
  const ancestors = new Map<string, DagReceipt>();
  const reachedLayers = new Set<ReceiptLayer>();
  const stack: string[] = [startReceiptId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const r = byId.get(id);
    if (r === undefined) continue;
    const next: string[] = [];
    if (r.parentReceiptId !== undefined) next.push(r.parentReceiptId);
    for (const ref of r.crossRefs ?? []) next.push(ref);
    for (const n of next) {
      const nr = byId.get(n);
      if (nr !== undefined && n !== startReceiptId && !ancestors.has(n)) {
        ancestors.set(n, nr);
        if (nr.layer !== undefined) reachedLayers.add(nr.layer);
        stack.push(n);
      }
    }
  }
  return { ancestors: [...ancestors.values()], reachedLayers };
}

// ── Proof-of-accountability verifier ──────────────────────────────────────────────
// Anyone holding the receipts can verify the chain AND that its root is the one anchored
// on-chain — WITHOUT trusting the issuer. Reads the receipt_anchor bucket and checks the
// accumulated root. (For a fresh single-anchor bucket, count==1 and
// bucket.root == SHA-256([0;32] || anchoredRoot); a multi-anchor bucket needs the full
// anchor sequence to verify a lone root, which we surface rather than fake.)

export interface VerifyAnchoredRootResult {
  anchored: boolean;
  bucketPda: string;
  onChainRoot: string | null; // hex
  count: number | null;
  bucketId: bigint | null;
  matchesFreshAccumulator: boolean | null;
  note?: string;
}

export interface AccountabilityVerdict {
  accountable: boolean;
  chainValid: boolean;
  chainViolation?: string;
  merkleRoot: string; // hex
  rootAnchored: boolean;
  layersCovered: ReceiptLayer[];
  anchor: VerifyAnchoredRootResult;
}

/** AnchorBucket layout: [ver1][bump1][bucket_id8 LE][count4 LE][root32][updated_at8 LE]. */
function parseAnchorBucket(data: Uint8Array): { bucketId: bigint; count: number; root: string } {
  const b = Buffer.from(data);
  return {
    bucketId: b.readBigUInt64LE(2),
    count: b.readUInt32LE(10),
    root: Buffer.from(b.subarray(14, 46)).toString("hex"),
  };
}

/**
 * Verify that `rootHex` was anchored into a receipt_anchor bucket. Pass either the
 * `bucketPda` (read it directly) or the `bucketId` (derive the PDA). Read-only.
 */
/**
 * PURE accumulator check (no chain, no web3.js) — does `rootHex` match what a fresh
 * (count==1) receipt_anchor bucket accumulated? bucket.root == SHA-256([0;32] || root).
 * Exported so the verification logic is testable offline against raw bucket bytes.
 */
export function checkAccumulatedRoot(
  rootHex: string,
  bucketData: Uint8Array
): Omit<VerifyAnchoredRootResult, "bucketPda"> {
  const { bucketId, count, root: onChainRoot } = parseAnchorBucket(bucketData);
  const expectFresh = sha256buf(Buffer.concat([Buffer.alloc(32), Buffer.from(rootHex, "hex")])).toString("hex");
  let matchesFreshAccumulator: boolean | null = null;
  let note: string | undefined;
  if (count === 1) {
    matchesFreshAccumulator = onChainRoot === expectFresh;
  } else {
    note = `bucket count=${count}; a lone root only verifies directly against a fresh (count==1) bucket — multi-anchor buckets need the full anchor sequence`;
  }
  const r: Omit<VerifyAnchoredRootResult, "bucketPda"> = {
    anchored: matchesFreshAccumulator === true, onChainRoot, count, bucketId, matchesFreshAccumulator,
  };
  if (note !== undefined) r.note = note;
  return r;
}

export async function verifyAnchoredRoot(
  rootHex: string,
  connection: Connection,
  options: { programId?: string; bucketId?: bigint; bucketPda?: string }
): Promise<VerifyAnchoredRootResult> {
  const { PublicKey } = await import("@solana/web3.js");
  const programId = new PublicKey(options.programId ?? RECEIPT_ANCHOR_PROGRAM_ID);

  let bucketPda: InstanceType<typeof PublicKey>;
  if (options.bucketPda !== undefined) {
    bucketPda = new PublicKey(options.bucketPda);
  } else if (options.bucketId !== undefined) {
    const le = Buffer.alloc(8); le.writeBigUInt64LE(options.bucketId);
    bucketPda = PublicKey.findProgramAddressSync([Buffer.from(RECEIPT_ANCHOR_BUCKET_SEED), le], programId)[0];
  } else {
    throw new Error("verifyAnchoredRoot: pass bucketPda or bucketId");
  }

  const acc = await connection.getAccountInfo(bucketPda, "confirmed");
  if (acc === null) {
    return { anchored: false, bucketPda: bucketPda.toBase58(), onChainRoot: null, count: null, bucketId: null, matchesFreshAccumulator: null, note: "bucket account not found" };
  }
  return { ...checkAccumulatedRoot(rootHex, acc.data), bucketPda: bucketPda.toBase58() };
}

/**
 * One-call proof of accountability: given the receipt batch (payment -> access -> job),
 * verify the DAG chain (anti-equivocation + parent linkage), recompute its Merkle root,
 * and confirm that root is anchored on-chain. Returns a structured verdict.
 */
export async function verifyAccountability(
  batch: DagReceipt[],
  connection: Connection,
  options: { programId?: string; bucketId?: bigint; bucketPda?: string }
): Promise<AccountabilityVerdict> {
  const chain = verifyDagChain(batch);
  const merkleRoot = buildDagMerkleRoot(batch).toString("hex");
  const anchor = await verifyAnchoredRoot(merkleRoot, connection, options);
  const layers = new Set<ReceiptLayer>();
  for (const r of batch) if (r.layer !== undefined) layers.add(r.layer);
  const out: AccountabilityVerdict = {
    accountable: chain.valid && anchor.anchored,
    chainValid: chain.valid,
    merkleRoot,
    rootAnchored: anchor.anchored,
    layersCovered: [...layers],
    anchor,
  };
  if (chain.violation !== undefined) out.chainViolation = chain.violation;
  return out;
}
