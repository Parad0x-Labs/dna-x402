/**
 * null-miner-sdk — Semaphore ZK identity
 *
 * Semaphore (Buterin 2020, Gurkan et al 2021) is an anonymous signaling
 * protocol: a group member can broadcast a signal without revealing their
 * identity. The key insight: encode "I am in this set" as a Merkle path
 * proof, encode "I have not signaled before in this context" as a
 * nullifier hash — both in one Groth16 proof.
 *
 * Used in Tornado Cash, Semaphore v3, Bandada. First applied to x402
 * DePIN receipt anti-replay here.
 *
 *   identityCommitment = Poseidon2([nullifier, trapdoor])     -- leaf in tree
 *   nullifierHash(ctx) = Poseidon2([nullifier, extNullifier]) -- prevents re-use per ctx
 *
 * This module is the OFF-CHAIN side: builds identity, inserts into the
 * incremental Merkle tree, and produces signal witnesses for snarkjs/rapidsnark.
 * On-chain verification is handled by programs/dark_semaphore.
 */

import { createHash, randomBytes } from "crypto";
import {
  bytesToField,
  fieldToBytes,
  poseidonHash2,
  poseidonMerkleHash,
} from "./poseidon.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Merkle tree depth — matches programs/dark_semaphore MAX_DEPTH. */
export const SEMAPHORE_TREE_DEPTH = 20;

/** Zero leaf: the empty node in the Poseidon Merkle tree. */
export const ZERO_LEAF = Buffer.alloc(32);

// ── Identity ──────────────────────────────────────────────────────────────────

/** A Semaphore identity. nullifier + trapdoor are private; identityCommitment is public. */
export interface SemaphoreIdentity {
  /** 32-byte secret nullifier — never share. Enables nullifier hashes. */
  nullifier: Buffer;
  /** 32-byte secret trapdoor — never share. Hides nullifier in commitment. */
  trapdoor: Buffer;
  /** Poseidon2([nullifier_field, trapdoor_field]) — safe to publish as Merkle leaf. */
  identityCommitment: Buffer;
}

/**
 * Generate a fresh Semaphore identity with cryptographically random secrets.
 *
 * @example
 * const id = generateIdentity();
 * // id.identityCommitment → submit to dark_semaphore AddMember instruction
 * // id.nullifier + id.trapdoor → store securely offline
 */
export function generateIdentity(): SemaphoreIdentity {
  const nullifier = randomBytes(32);
  const trapdoor  = randomBytes(32);
  return { nullifier, trapdoor, identityCommitment: computeIdentityCommitment(nullifier, trapdoor) };
}

/**
 * Derive a deterministic Semaphore identity from a spend key.
 * Used by AgentPassport to avoid storing additional secrets.
 *
 *   nullifier = SHA-256("semaphore-nullifier-v1" || spendKey)
 *   trapdoor  = SHA-256("semaphore-trapdoor-v1"  || spendKey)
 */
export function deriveIdentityFromKey(spendKey: Buffer): SemaphoreIdentity {
  const nullifier = domain("semaphore-nullifier-v1", spendKey);
  const trapdoor  = domain("semaphore-trapdoor-v1",  spendKey);
  return { nullifier, trapdoor, identityCommitment: computeIdentityCommitment(nullifier, trapdoor) };
}

/**
 * Reconstruct an identity from stored nullifier + trapdoor buffers.
 */
export function reconstructIdentity(nullifier: Buffer, trapdoor: Buffer): SemaphoreIdentity {
  return { nullifier, trapdoor, identityCommitment: computeIdentityCommitment(nullifier, trapdoor) };
}

/** Compute identityCommitment = Poseidon2([nullifier_field, trapdoor_field]). */
export function computeIdentityCommitment(nullifier: Buffer, trapdoor: Buffer): Buffer {
  return fieldToBytes(poseidonHash2(bytesToField(nullifier), bytesToField(trapdoor)));
}

// ── Nullifier Hash ─────────────────────────────────────────────────────────────

/**
 * Compute a context-specific nullifier hash.
 *
 *   nullifierHash = Poseidon2([nullifier_field, externalNullifier_field])
 *
 * Different externalNullifiers produce different, unlinkable nullifierHashes
 * for the same identity. One identity can signal once per context (external
 * nullifier) — the dark_semaphore NullifierRecord PDA rejects duplicates.
 *
 * @example
 * const ext = buildExternalNullifier("null-miner-task-v1", taskGroupId);
 * const nh  = computeNullifierHash(identity.nullifier, ext);
 * // Submit nh in the Signal instruction to programs/dark_semaphore
 */
export function computeNullifierHash(nullifier: Buffer, externalNullifier: Buffer): Buffer {
  return fieldToBytes(poseidonHash2(bytesToField(nullifier), bytesToField(externalNullifier)));
}

/**
 * Build a 32-byte external nullifier for a context.
 * H("domain" || contextId_bytes) — deterministic, public.
 */
export function buildExternalNullifier(domain_: string, contextId: string): Buffer {
  return domain(domain_, Buffer.from(contextId, "utf8"));
}

// ── Incremental Merkle Tree ────────────────────────────────────────────────────

/**
 * Precompute zero-hash array for a Poseidon Merkle tree.
 * zeros[0] = ZERO_LEAF, zeros[i] = Poseidon(zeros[i-1], zeros[i-1]).
 */
export function computeZeroHashes(depth: number): Buffer[] {
  const zeros: Buffer[] = [Buffer.from(ZERO_LEAF)];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidonMerkleHash(zeros[i - 1]!, zeros[i - 1]!));
  }
  return zeros;
}

/** Merkle inclusion proof for a leaf in the incremental tree. */
export interface MerkleProof {
  leaf: Buffer;
  /** Sibling nodes at each level from leaf to root. */
  siblings: Buffer[];
  /** 0 = current node is left child, 1 = current node is right child. */
  pathIndices: number[];
  root: Buffer;
}

/**
 * Sparse incremental Merkle tree using Poseidon node hashes.
 * Sequential insertion; O(log N) update; stores only non-zero nodes.
 *
 * @example
 * const tree = new IncrementalMerkleTree(20);
 * const idx  = tree.insert(identity.identityCommitment);
 * const proof = tree.generateProof(idx);
 * IncrementalMerkleTree.verifyProof(proof.leaf, proof.siblings, proof.pathIndices, proof.root);
 */
export class IncrementalMerkleTree {
  private readonly depth: number;
  private readonly zeros: Buffer[];
  private readonly nodes: Map<string, Buffer> = new Map();
  private nextIndex = 0;

  constructor(depth: number = SEMAPHORE_TREE_DEPTH) {
    this.depth = depth;
    this.zeros = computeZeroHashes(depth);
  }

  get size(): number    { return this.nextIndex; }
  get capacity(): number { return 1 << this.depth; }

  /** Insert a leaf; returns its index. */
  insert(leaf: Buffer): number {
    if (this.nextIndex >= this.capacity) throw new Error(`Tree full (capacity ${this.capacity})`);
    const index = this.nextIndex++;
    this.updatePath(index, leaf);
    return index;
  }

  /** Current Merkle root (all-zero root when tree is empty). */
  get root(): Buffer {
    return this.getNode(this.depth, 0);
  }

  /** Generate a Merkle inclusion proof for the leaf at `index`. */
  generateProof(index: number): MerkleProof {
    if (index >= this.nextIndex) throw new Error(`Leaf at index ${index} not yet inserted`);
    const siblings: Buffer[] = [];
    const pathIndices: number[] = [];
    let idx = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathIndices.push(idx % 2);
      siblings.push(this.getNode(lvl, siblingIdx));
      idx = Math.floor(idx / 2);
    }
    return { leaf: this.getNode(0, index), siblings, pathIndices, root: this.root };
  }

  /** Verify a Merkle proof (static — no tree instance needed). */
  static verifyProof(leaf: Buffer, siblings: Buffer[], pathIndices: number[], root: Buffer): boolean {
    let node = leaf;
    for (let i = 0; i < siblings.length; i++) {
      node = pathIndices[i] === 0
        ? poseidonMerkleHash(node, siblings[i]!)
        : poseidonMerkleHash(siblings[i]!, node);
    }
    return node.equals(root);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private nodeKey(level: number, index: number): string { return `${level}:${index}`; }

  private getNode(level: number, index: number): Buffer {
    return this.nodes.get(this.nodeKey(level, index)) ?? Buffer.from(this.zeros[level]!);
  }

  private setNode(level: number, index: number, value: Buffer): void {
    this.nodes.set(this.nodeKey(level, index), value);
  }

  private updatePath(leafIndex: number, leaf: Buffer): void {
    this.setNode(0, leafIndex, leaf);
    let idx = leafIndex;
    let current = leaf;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const sibling = this.getNode(lvl, idx % 2 === 0 ? idx + 1 : idx - 1);
      current = idx % 2 === 0
        ? poseidonMerkleHash(current, sibling)
        : poseidonMerkleHash(sibling, current);
      idx = Math.floor(idx / 2);
      this.setNode(lvl + 1, idx, current);
    }
  }
}

// ── Signal Witness ─────────────────────────────────────────────────────────────

/**
 * A Semaphore signal witness — all off-chain data needed to build a Groth16 proof.
 * Pass to snarkjs/rapidsnark with the semaphore.circom circuit to get a 288-byte proof.
 * Until the circuit is compiled, use the nullifierHash server-side via
 * programs/dark_semaphore NullifierRecord PDA for devnet replay prevention.
 */
export interface SemaphoreSignalWitness {
  identity: SemaphoreIdentity;
  merkleProof: MerkleProof;
  externalNullifier: Buffer;
  /** Poseidon2([nullifier, externalNullifier]) — public output for on-chain check. */
  nullifierHash: Buffer;
  /** SHA-256("semaphore-signal-v1" || signal) — public output committed in proof. */
  signalHash: Buffer;
}

/**
 * Build a complete Semaphore signal witness.
 *
 * @example
 * const witness = buildSignalWitness({
 *   identity,
 *   tree,
 *   leafIndex,
 *   externalNullifier: buildExternalNullifier("null-miner-task-v1", taskGroupId),
 *   signal: Buffer.from(taskId, "hex"),
 * });
 */
export function buildSignalWitness(opts: {
  identity: SemaphoreIdentity;
  tree: IncrementalMerkleTree;
  leafIndex: number;
  externalNullifier: Buffer;
  signal: Buffer;
}): SemaphoreSignalWitness {
  return {
    identity: opts.identity,
    merkleProof: opts.tree.generateProof(opts.leafIndex),
    externalNullifier: opts.externalNullifier,
    nullifierHash: computeNullifierHash(opts.identity.nullifier, opts.externalNullifier),
    signalHash: domain("semaphore-signal-v1", opts.signal),
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function domain(tag: string, data: Buffer): Buffer {
  return createHash("sha256").update(Buffer.from(tag)).update(data).digest();
}
