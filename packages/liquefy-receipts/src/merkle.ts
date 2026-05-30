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
 * Each leaf = SHA-256(JSON.stringify(receipt)).
 * Each internal node = SHA-256(left || right).
 */

import { createHash } from "node:crypto";
import type { X402Receipt } from "./compress.js";

const ZERO = Buffer.alloc(32, 0);

function sha256(data: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function hashInternal(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([left, right]));
}

function hashLeaf(receipt: X402Receipt): Buffer {
  return sha256(Buffer.from(JSON.stringify(receipt)));
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
      carry = carry === null ? node : hashInternal(node, carry);
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

  constructor(receipts: X402Receipt[]) {
    this.leaves = receipts.map(hashLeaf);
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
          next.push(current[i]); // odd node: pass straight up, no duplication
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
    return {
      leaf: this.leaves[index],
      index,
      siblings,
      sides,
      passThrough,
      root:     this.root(),
      treeSize: this.leaves.length,
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
  const leaf = hashLeaf(receipt);
  return leaf.equals(proof.leaf) && verifyProof(proof);
}

// ── Root anchor helpers ───────────────────────────────────────────────────────

/**
 * Build a Merkle root from a receipt array — in-memory, straightforward.
 * For large batches (>1M), use StreamingMerkleBuilder instead.
 */
export function buildReceiptRoot(receipts: X402Receipt[]): Buffer {
  const builder = new StreamingMerkleBuilder();
  for (const r of receipts) builder.add(r);
  return builder.root();
}

/** Hex-encode a root buffer for logging / display. */
export function rootHex(root: Buffer): string {
  return root.toString("hex");
}
