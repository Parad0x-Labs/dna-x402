// Voucher format, signing, wire encoding, batch leaves and the batch Merkle
// tree. Mirrors programs/x402_settle/src/crypto.rs and instruction.rs.

import { concat, sha256, u64le, readU64 } from "./bytes.ts";
import type { Signer } from "./ed25519.ts";

export const VOUCHER_TAG = new TextEncoder().encode("X402STL1");
export const MSG_LEN = 224;
export const VOUCHER_WIRE_LEN = 116;
export const CLOSE_WIRE_LEN = 115;
export const NO_BOOK = 0xff;
const SALT_DOMAIN = new TextEncoder().encode("x402-settle:domain:v1");

/** Fields a payer signs. `scope` is the escrow scope (lane B2) or the channel scope (lane C). */
export interface VoucherFields {
  programId: Uint8Array;
  /** 32 zero bytes for SOL. */
  mint: Uint8Array;
  /** The ledger's cluster salt (`decodeLedger(...).salt`). */
  salt: Uint8Array;
  payer: Uint8Array;
  payee: Uint8Array;
  scope: bigint;
  /** Total paid from payer to payee in this scope, including this payment. */
  cumulative: bigint;
  /** Last slot at which the voucher may be submitted. */
  expirySlot: bigint;
  /** SHA-256 of the x402 quote this payment answers. */
  quoteHash: Uint8Array;
}

export interface SignedVoucher extends VoucherFields {
  signature: Uint8Array;
}

/** The 224-byte signed message:
 * tag 8 | program id 32 | mint 32 | salt 32 | payer 32 | payee 32 | scope u64 | cumulative u64 | expiry u64 | quote hash 32. */
export function voucherMessage(f: VoucherFields): Uint8Array {
  for (const [n, v] of [["programId", f.programId], ["mint", f.mint], ["salt", f.salt], ["payer", f.payer], ["payee", f.payee], ["quoteHash", f.quoteHash]] as const) {
    if (v.length !== 32) throw new Error(`${n} must be 32 bytes`);
  }
  const m = concat(VOUCHER_TAG, f.programId, f.mint, f.salt, f.payer, f.payee, u64le(f.scope), u64le(f.cumulative), u64le(f.expirySlot), f.quoteHash);
  if (m.length !== MSG_LEN) throw new Error("bad message length");
  return m;
}

export function signVoucher(payer: Signer, f: Omit<VoucherFields, "payer">): SignedVoucher {
  const full: VoucherFields = { ...f, payer: payer.publicKey };
  return { ...full, signature: payer.sign(voucherMessage(full)) };
}

/** Per-ledger cluster salt (computed by InitLedger from a SlotHashes entry). */
export function ledgerSalt(programId: Uint8Array, mint: Uint8Array, slot: bigint, slotHash: Uint8Array): Uint8Array {
  return sha256(SALT_DOMAIN, programId, mint, u64le(slot), slotHash);
}

/** Account indexes of a B2 voucher inside its instruction. */
export interface VoucherRefs {
  escrowIx: number;
  pairIx: number;
  bookIx: number;
  slot: number;
}

export function encodeWireVoucher(r: VoucherRefs, v: Pick<SignedVoucher, "cumulative" | "expirySlot" | "quoteHash" | "signature">): Uint8Array {
  return concat(Uint8Array.of(r.escrowIx, r.pairIx, r.bookIx, r.slot), u64le(v.cumulative), u64le(v.expirySlot), v.quoteHash, v.signature);
}

export function encodeWireClose(
  r: { channelIx: number; bookIx: number; slot: number },
  v: Pick<SignedVoucher, "cumulative" | "expirySlot" | "quoteHash" | "signature">,
): Uint8Array {
  return concat(Uint8Array.of(r.channelIx, r.bookIx, r.slot), u64le(v.cumulative), u64le(v.expirySlot), v.quoteHash, v.signature);
}

export function decodeWireVoucher(b: Uint8Array) {
  return {
    escrowIx: b[0]!,
    pairIx: b[1]!,
    bookIx: b[2]!,
    slot: b[3]!,
    cumulative: readU64(b, 4),
    expirySlot: readU64(b, 12),
    quoteHash: b.slice(20, 52),
    signature: b.slice(52, 116),
  };
}

// ---------------------------------------------------------------------------
// Two-phase batch tree
// ---------------------------------------------------------------------------

/** Leaf of a two-phase batch: the amount the voucher moves and its message. */
export function batchLeaf(delta: bigint, message: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(0), u64le(delta), message);
}

export function node(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(1), l, r);
}

export function zeroRoot(h: number): Uint8Array {
  let z: Uint8Array = new Uint8Array(32);
  for (let i = 0; i < h; i++) z = node(z, z);
  return z;
}

/** Root of a height-`h` subtree holding `leaves` then zero leaves. */
export function subtreeRoot(leaves: Uint8Array[], h: number): Uint8Array {
  if (leaves.length > 1 << h) throw new Error("too many leaves");
  let lvl = leaves.slice();
  let zero: Uint8Array = new Uint8Array(32);
  for (let i = 0; i < h; i++) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < lvl.length; j += 2) next.push(node(lvl[j]!, j + 1 < lvl.length ? lvl[j + 1]! : zero));
    lvl = next;
    zero = node(zero, zero);
  }
  return lvl.length ? lvl[0]! : zero;
}

export function upperDepth(numChunks: number): number {
  let d = 0;
  while (1 << d < numChunks) d++;
  return d;
}

export function foldProof(acc: Uint8Array, index: number, proof: Uint8Array[]): Uint8Array {
  let a = acc;
  proof.forEach((sib, j) => {
    a = (index >> j) & 1 ? node(sib, a) : node(a, sib);
  });
  return a;
}

/** Chunk roots, batch root and per-chunk proofs for `leaves` split in chunks of `chunkSize` (subtree height `chunkLog`). */
export function batchTree(leaves: Uint8Array[], chunkLog: number, chunkSize: number) {
  if (chunkSize < 1 || chunkSize > 1 << chunkLog) throw new Error("chunk size out of range");
  const chunkRoots: Uint8Array[] = [];
  for (let i = 0; i < leaves.length; i += chunkSize) chunkRoots.push(subtreeRoot(leaves.slice(i, i + chunkSize), chunkLog));
  const depth = upperDepth(chunkRoots.length);
  const levels: Uint8Array[][] = [];
  let lvl = chunkRoots.slice();
  let zero = zeroRoot(chunkLog);
  for (let d = 0; d < depth; d++) {
    if (lvl.length % 2 === 1) lvl.push(zero);
    levels.push(lvl);
    const next: Uint8Array[] = [];
    for (let j = 0; j < lvl.length; j += 2) next.push(node(lvl[j]!, lvl[j + 1]!));
    lvl = next;
    zero = node(zero, zero);
  }
  const root = lvl[0]!;
  const proof = (c: number): Uint8Array[] => {
    let idx = c;
    return levels.map((l) => {
      const s = l[idx ^ 1]!;
      idx >>= 1;
      return s;
    });
  };
  return { chunkRoots, depth, root, proof };
}
