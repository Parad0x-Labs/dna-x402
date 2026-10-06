/**
 * null-miner-sdk — dark_null_lottery ticket commitments (mirror of the
 * program's `ticket.rs`).
 *
 *   leaf = SHA-256("dark-null-lottery:ticket:v1" || round_id_le[8] || owner[32]
 *                  || numbers[5] (ascending) || nullifier[32])
 *   node = SHA-256(0x01 || left[32] || right[32])
 *
 * Depth ceil(log2(count)); an odd level repeats its last node. A proof is the
 * sibling list from the leaf up; bit k of the leaf index says whether the node
 * at level k is a right child. `owner` is the Solana key allowed to claim.
 *
 * Fallback selection (FallbackDraw over three consecutive Drawn rounds):
 *   index = u64_le(SHA-256("dark-null-lottery:fallback:v1" || seed[32]
 *                          || round_id_le[8])[0..8]) mod ticket_count
 * where seed is the third round's committed draw seed and the pool is that
 * round's anchored tickets tree.
 */

import { createHash } from "crypto";

export const TICKET_LEAF_TAG = "dark-null-lottery:ticket:v1";
export const FALLBACK_TAG    = "dark-null-lottery:fallback:v1";
/** Upper bound on the proof length ClaimJackpot accepts. */
export const MAX_PROOF_DEPTH = 32;

export type Bytes32 = Uint8Array;
type RoundId = number | bigint;

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** 32 bytes from a Uint8Array or a 64-char hex string. */
export function bytes32(v: string | Uint8Array, what = "value"): Bytes32 {
  if (typeof v === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`ticketTree: ${what} must be 32 bytes hex`);
    return new Uint8Array(Buffer.from(v, "hex"));
  }
  if (v.length !== 32) throw new Error(`ticketTree: ${what} must be 32 bytes`);
  return new Uint8Array(v);
}

export function u64le(n: RoundId): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new Error("ticketTree: value out of u64 range");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return new Uint8Array(b);
}

// ── base58 (Solana keys) ──────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const d = B58.indexOf(c);
    if (d < 0) throw new Error("ticketTree: invalid base58");
    n = n * 58n + BigInt(d);
  }
  const out: number[] = [];
  while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.push(0); }
  return new Uint8Array(out.reverse());
}

export function encodeBase58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}

/** The 32-byte owner key from a base58 Solana address or raw bytes. */
export function ownerKeyBytes(owner: string | Uint8Array): Bytes32 {
  const b = typeof owner === "string" ? decodeBase58(owner) : owner;
  if (b.length !== 32) throw new Error("ticketTree: owner must be a 32-byte Solana key");
  return new Uint8Array(b);
}

/** 5 distinct numbers in 1..=30, ascending (the form a ticket commits to). */
export function canonicalNumbers(numbers: number[]): number[] {
  if (numbers.length !== 5) throw new Error("ticketTree: a ticket has 5 numbers");
  const n = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < 5; i++) {
    if (!Number.isInteger(n[i]) || n[i] < 1 || n[i] > 30) throw new Error("ticketTree: numbers must be in 1..30");
    if (i > 0 && n[i] === n[i - 1]) throw new Error("ticketTree: numbers must be distinct");
  }
  return n;
}

// ── Tree ──────────────────────────────────────────────────────────────────────

export function ticketLeaf(
  roundId:   RoundId,
  owner:     string | Uint8Array,
  numbers:   number[],
  nullifier: string | Uint8Array,
): Bytes32 {
  return sha256(
    new TextEncoder().encode(TICKET_LEAF_TAG),
    u64le(roundId),
    ownerKeyBytes(owner),
    Uint8Array.from(canonicalNumbers(numbers)),
    bytes32(nullifier, "nullifier"),
  );
}

export function ticketNode(left: Bytes32, right: Bytes32): Bytes32 {
  return sha256(Uint8Array.of(0x01), left, right);
}

/** ceil(log2(count)), 0 for count <= 1. */
export function treeDepth(count: number): number {
  let d = 0;
  while (2 ** d < count) d++;
  return d;
}

function nextLevel(level: Bytes32[]): Bytes32[] {
  const out: Bytes32[] = [];
  for (let i = 0; i < level.length; i += 2) out.push(ticketNode(level[i], level[i + 1] ?? level[i]));
  return out;
}

/** Root of the tickets tree over `leaves` (ticket order); 32 zero bytes when empty. */
export function ticketsRoot(leaves: Bytes32[]): Bytes32 {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

/** Sibling path of leaf `index`, from the leaf up. */
export function ticketsProof(leaves: Bytes32[], index: number): Bytes32[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error("ticketTree: leaf index out of range");
  }
  const proof: Bytes32[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    proof.push(level[i ^ 1] ?? level[level.length - 1]);
    level = nextLevel(level);
    i >>= 1;
  }
  return proof;
}

export function rootFromProof(leaf: Bytes32, index: number | bigint, proof: Bytes32[]): Bytes32 {
  let acc = leaf;
  const idx = BigInt(index);
  proof.forEach((sibling, level) => {
    acc = (idx >> BigInt(level)) & 1n ? ticketNode(sibling, acc) : ticketNode(acc, sibling);
  });
  return acc;
}

/** Leaf index the program's FallbackDraw selects among `ticketCount` tickets. */
export function fallbackWinnerIndex(seed: string | Uint8Array, roundId: RoundId, ticketCount: number): number {
  if (!Number.isInteger(ticketCount) || ticketCount <= 0) {
    throw new Error("ticketTree: ticketCount must be a positive integer");
  }
  const h = sha256(new TextEncoder().encode(FALLBACK_TAG), bytes32(seed, "seed"), u64le(roundId));
  return Number(Buffer.from(h).readBigUInt64LE(0) % BigInt(ticketCount));
}

/**
 * ClaimJackpot (0x06) instruction data:
 *   [0x06, nullifier[32], numbers[5], leaf_index[8] LE, proof_len[1], proof[32 * proof_len]]
 */
export function claimJackpotData(
  nullifier: string | Uint8Array,
  numbers:   number[],
  leafIndex: number,
  proof:     Bytes32[],
): Uint8Array {
  if (proof.length > MAX_PROOF_DEPTH) throw new Error("ticketTree: proof too long");
  return new Uint8Array(Buffer.concat([
    Uint8Array.of(0x06),
    bytes32(nullifier, "nullifier"),
    Uint8Array.from(canonicalNumbers(numbers)),
    u64le(leafIndex),
    Uint8Array.of(proof.length),
    ...proof.map((p) => bytes32(p, "proof node")),
  ]));
}
