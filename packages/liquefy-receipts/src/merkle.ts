/**
 * Streaming Merkle tree for x402 receipt batches.
 *
 * Key properties:
 * - STREAMING: O(log N) memory — never holds all receipts in RAM.
 *   Process 36 billion receipts with ~64 nodes in memory.
 * - 32-byte root on-chain always — whether 1 or 1 trillion receipts.
 * - ZK-ready: the root is what a Groth16 circuit proves membership against.
 * - Inclusion proofs: anyone can verify any receipt is in the batch.
 *
 * Algorithm: online binary Merkle tree (keep only log2(N) pending nodes).
 * Hashing is domain-separated per RFC-6962 §2.1 to block the second-preimage
 * attack (presenting an internal node as a leaf, or vice-versa):
 *   leaf hash     = SHA-256(0x00 || JSON.stringify(receipt))
 *   internal node = SHA-256(0x01 || left || right)
 */

import { createHash, hkdfSync } from "node:crypto";
import type { X402Receipt } from "./compress.js";

const ZERO = Buffer.alloc(32, 0);

// RFC-6962 §2.1 domain-separation prefixes. Hashing leaves and internal nodes in
// distinct domains means a leaf hash and an internal-node hash can never collide
// over the same bytes — this is what blocks the second-preimage forgery where an
// attacker presents an internal node's (left || right) preimage as a leaf.
const LEAF_PREFIX     = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

function sha256(data: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** RFC-6962 leaf hash over raw bytes: SHA-256(0x00 || data). */
export function hashLeafBytes(data: Buffer | Uint8Array): Buffer {
  return sha256(Buffer.concat([LEAF_PREFIX, data]));
}

/** RFC-6962 internal-node hash: SHA-256(0x01 || left || right). */
export function hashInternal(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([INTERNAL_PREFIX, left, right]));
}

function hashLeaf(receipt: X402Receipt): Buffer {
  return hashLeafBytes(Buffer.from(JSON.stringify(receipt)));
}

// ── Salted (hiding) leaf commitment — v2 ──────────────────────────────────────
//
// The bare v1 leaf SHA-256(0x00 || JSON.stringify(receipt)) is a DETERMINISTIC
// commitment over low-entropy, publicly-observable fields: amount, sender,
// receiver, timestamp and programId all mirror an on-chain Solana payment.
// Anyone holding the public on-chain root plus an inclusion proof can therefore
// brute-force / confirm a receipt's contents offline — defeating the
// encryption-at-rest story (you never have to decrypt the Arweave blob).
//
// v2 blinds each leaf with a secret per-leaf salt:
//   leaf_i = SHA-256(0x00 || 0x02 || salt_i || canonical(receipt_i))
//   salt_i = HKDF-SHA256(batchSecret, "liquefy-leaf-salt-v1" || u64_be(i))
// The batchSecret lives ONLY inside the encrypted Arweave blob; without it the
// public root reveals nothing about low-entropy fields. Opening leaf i reveals
// (salt_i, receipt_i) only — the one-way per-leaf derivation keeps every other
// leaf hidden, so selective disclosure stays selective.

/** v2 leaf scheme tag — sits INSIDE the 0x00 RFC-6962 leaf domain. */
const LEAF_SCHEME_V2 = Buffer.from([0x02]);
const SALT_DOMAIN    = "liquefy-leaf-salt-v1";
/** Per-leaf salt length in bytes. */
export const LEAF_SALT_BYTES = 32;

/**
 * Deterministic, canonical, bigint-safe byte encoding of a receipt.
 *
 * Unlike JSON.stringify this (a) sorts object keys so insertion order is
 * irrelevant, (b) encodes bigint and integer numbers identically — so an
 * `amount` typed as 1000n or 1000 yields the same leaf, surviving the
 * bigint→Number coercion in decompressReceipts, and (c) never throws on bigint
 * (JSON.stringify(1n) throws). Strings stay quoted so a numeric field can never
 * collide with its stringified form.
 */
export function canonicalReceiptBytes(receipt: X402Receipt): Buffer {
  return Buffer.from(canonicalize(receipt), "utf8");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "bigint":  return value.toString();
    case "number":  return Number.isFinite(value) ? numToCanonical(value) : "null";
    case "boolean": return value ? "true" : "false";
    case "string":  return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
      const obj  = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default: return "null";
  }
}

/** Integers (number or bigint) share one canonical form so the type never forks the leaf. */
function numToCanonical(n: number): string {
  return Number.isInteger(n) ? BigInt(n).toString() : n.toString();
}

/**
 * Derive the per-leaf salt for `index` from a 32-byte batch secret via HKDF-SHA256.
 * One-way: revealing one salt leaks neither the batch secret nor any other salt.
 */
export function deriveLeafSalt(batchSecret: Buffer | Uint8Array, index: number): Buffer {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`leaf index must be a non-negative integer, got ${index}`);
  }
  const info = Buffer.alloc(SALT_DOMAIN.length + 8);
  info.write(SALT_DOMAIN, 0, "utf8");
  info.writeBigUInt64BE(BigInt(index), SALT_DOMAIN.length);
  return Buffer.from(hkdfSync("sha256", batchSecret, Buffer.alloc(0), info, LEAF_SALT_BYTES));
}

/**
 * v2 salted leaf hash: SHA-256(0x00 || 0x02 || salt || canonical(receipt)).
 * The salt sits inside the 0x00 leaf domain, so RFC-6962 leaf/internal
 * second-preimage separation is preserved.
 */
export function hashSaltedLeaf(receipt: X402Receipt, salt: Buffer | Uint8Array): Buffer {
  return hashLeafBytes(Buffer.concat([LEAF_SCHEME_V2, Buffer.from(salt), canonicalReceiptBytes(receipt)]));
}

// ── Streaming builder ─────────────────────────────────────────────────────────

/**
 * StreamingMerkleBuilder processes receipts one at a time with O(log N) memory.
 * Feed receipts via .add(), then call .root() for the final 32-byte root.
 */
export class StreamingMerkleBuilder {
  private stack: (Buffer | null)[] = []; // pending nodes at each level
  private count = 0;

  add(receipt: X402Receipt): void {
    this.pushLeaf(hashLeaf(receipt));
    this.count++;
  }

  /**
   * Push a precomputed leaf hash directly. The caller must domain-separate it
   * with {@link hashLeafBytes} (SHA-256(0x00 || data)); feeding a bare SHA-256 of
   * the data would reopen the second-preimage attack this tree guards against.
   */
  addRaw(leafHash: Buffer): void {
    this.pushLeaf(leafHash);
    this.count++;
  }

  get leafCount(): number {
    return this.count;
  }

  private pushLeaf(leaf: Buffer): void {
    let carry = leaf;
    for (let level = 0; level < this.stack.length; level++) {
      const pending = this.stack[level];
      if (pending === null) {
        this.stack[level] = carry;
        return;
      }
      carry = hashInternal(pending, carry);
      this.stack[level] = null;
    }
    this.stack.push(carry);
  }

  /** Finalize and return the 32-byte Merkle root. */
  root(): Buffer {
    if (this.count === 0) return ZERO;
    // Combine from LOWEST level (smallest block) upward.
    // When combining, the higher-indexed (larger, older) block goes on the LEFT —
    // this matches MerkleTree's left-to-right pairwise algorithm for any batch size.
    // Example for n=7: stack=[h6, H45, H0123]
    //   carry=h6 → H(H45, h6) → H(H0123, H(H45,h6))  ✓
    let carry: Buffer | null = null;
    for (let i = 0; i < this.stack.length; i++) {
      const node = this.stack[i];
      if (node === null) continue;
      carry = carry === null ? node : hashInternal(node, carry); // node=larger/older block goes LEFT
    }
    return carry ?? ZERO;
  }
}

// ── In-memory tree (for inclusion proofs) ────────────────────────────────────

/**
 * In-memory Merkle tree — builds the full tree for proof generation.
 * Only use this when you need inclusion proofs AND can hold the tree in RAM.
 * For pure root anchoring, use StreamingMerkleBuilder.
 */
export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];
  private salts: (Buffer | null)[];

  /**
   * @param receipts    the batch
   * @param batchSecret optional — when supplied, leaves are v2 SALTED commitments
   *                    (salt_i = deriveLeafSalt(batchSecret, i)) and every proof
   *                    carries its per-leaf salt. Omit for the legacy unsalted v1
   *                    tree (kept only for back-compat with already-anchored roots).
   */
  constructor(receipts: X402Receipt[], batchSecret?: Buffer | Uint8Array) {
    if (batchSecret) {
      this.salts  = receipts.map((_, i) => deriveLeafSalt(batchSecret, i));
      this.leaves = receipts.map((r, i) => hashSaltedLeaf(r, this.salts[i]!));
    } else {
      this.salts  = receipts.map(() => null);
      this.leaves = receipts.map(hashLeaf);
    }
    this.layers = [this.leaves];
    this.build();
  }

  private build(): void {
    let current = this.leaves;
    while (current.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashInternal(current[i], current[i + 1]));
        } else {
          next.push(current[i]); // odd node: pass straight up (matches StreamingMerkleBuilder)
        }
      }
      this.layers.push(next);
      current = next;
    }
  }

  root(): Buffer {
    return this.layers[this.layers.length - 1][0] ?? ZERO;
  }

  /**
   * Generate an inclusion proof for the receipt at `index`.
   * Returns an array of sibling hashes from leaf to root.
   */
  proof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new RangeError(`index ${index} out of range [0, ${this.leaves.length})`);
    }
    const siblings:    Buffer[]  = [];
    const sides:       number[]  = [];
    const passThrough: boolean[] = [];
    let idx = index;
    for (let l = 0; l < this.layers.length - 1; l++) {
      const layer   = this.layers[l];
      const isRight = idx % 2 === 1;
      const isUnpaired = !isRight && idx === layer.length - 1; // last node, no right sibling
      passThrough.push(isUnpaired);
      if (!isUnpaired) {
        const sibIdx = isRight ? idx - 1 : idx + 1;
        siblings.push(layer[sibIdx]);
        sides.push(isRight ? 1 : 0);
      }
      idx = Math.floor(idx / 2);
    }
    const salt = this.salts[index];
    return {
      leaf: this.leaves[index],
      index,
      siblings,
      sides,
      passThrough,
      root:     this.root(),
      treeSize: this.leaves.length,
      ...(salt ? { salt } : {}),
    };
  }
}

// ── Inclusion proof ───────────────────────────────────────────────────────────

export interface MerkleProof {
  leaf:        Buffer;    // SHA-256 of the receipt
  index:       number;    // position in the batch
  siblings:    Buffer[];  // sibling hashes (one per paired level)
  sides:       number[];  // 0 = sibling on right, 1 = sibling on left
  passThrough: boolean[]; // true at level L = this node was unpaired, passed straight up
  root:        Buffer;    // the tree root
  treeSize:    number;    // total leaves
  salt?:       Buffer;    // v2 only: per-leaf salt, revealed so a verifier can recompute the salted leaf
}

/**
 * Verify a Merkle inclusion proof.
 * Returns true if the proof proves `leaf` is in the tree with `root`.
 */
export function verifyProof(proof: MerkleProof): boolean {
  let hash = proof.leaf;
  let s = 0; // index into siblings / sides (only for non-pass-through levels)
  for (let l = 0; l < proof.passThrough.length; l++) {
    if (proof.passThrough[l]) continue; // unpaired — node moves up unchanged
    const sibling = proof.siblings[s];
    const side    = proof.sides[s];
    hash = side === 1
      ? hashInternal(sibling, hash)  // sibling on left
      : hashInternal(hash, sibling); // sibling on right
    s++;
  }
  return hash.equals(proof.root);
}

/**
 * Verify a receipt is in a batch by computing its leaf hash and checking the proof.
 */
export function verifyReceiptInBatch(receipt: X402Receipt, proof: MerkleProof): boolean {
  // A salted (v2) proof binds the receipt through its revealed per-leaf salt;
  // an unsalted (v1) proof falls back to the legacy bare-JSON leaf.
  const leaf = proof.salt ? hashSaltedLeaf(receipt, proof.salt) : hashLeaf(receipt);
  return leaf.equals(proof.leaf) && verifyProof(proof);
}

// ── Root anchor helpers ───────────────────────────────────────────────────────

/**
 * Build a Merkle root from a receipt array — in-memory, straightforward.
 * For large batches (>1M), use StreamingMerkleBuilder instead.
 *
 * @param batchSecret optional 32-byte secret. When supplied, leaves are v2
 *   SALTED commitments (salt_i = deriveLeafSalt(batchSecret, i)) so the public
 *   root cannot be brute-forced from low-entropy receipt fields. Omit for the
 *   legacy unsalted v1 root.
 */
export function buildReceiptRoot(receipts: X402Receipt[], batchSecret?: Buffer | Uint8Array): Buffer {
  const builder = new StreamingMerkleBuilder();
  if (batchSecret) {
    receipts.forEach((r, i) => builder.addRaw(hashSaltedLeaf(r, deriveLeafSalt(batchSecret, i))));
  } else {
    for (const r of receipts) builder.add(r);
  }
  return builder.root();
}

/** Hex-encode a root buffer for logging / display. */
export function rootHex(root: Buffer): string {
  return root.toString("hex");
}
