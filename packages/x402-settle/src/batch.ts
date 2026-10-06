// Two-phase batch builder: BeginBatch, StageChunk per chunk, CommitBatch,
// ResolveStaged and CloseBatch instructions for a voucher set larger than one
// transaction. Either every voucher settles (commit) or none does (abort,
// then resolve returns every reservation).

import { toHex } from "./bytes.ts";
import * as ix from "./instructions.ts";
import type { Instruction } from "./instructions.ts";
import { batchPda } from "./pda.ts";
import type { SettleItem } from "./pack.ts";
import { batchLeaf, batchTree, encodeWireVoucher, voucherMessage, type VoucherFields } from "./voucher.ts";
import { fitsV1, v1Size } from "./v1.ts";

export const MAX_CHUNKS = 256;
export const MAX_CHUNK_LOG = 5;
export const MAX_BATCH_PAYEES = 16;

/** A voucher of a two-phase batch: the settle item plus the signed fields
 * (to rebuild the leaf) and the amount it moves (`cumulative - settled`). */
export interface BatchItem extends SettleItem {
  fields: VoucherFields;
  delta: bigint;
}

export interface TwoPhasePlan {
  batch: Uint8Array;
  root: Uint8Array;
  count: number;
  total: bigint;
  chunkLog: number;
  chunkSize: number;
  begin: Instruction;
  stages: Instruction[];
  commit: Instruction;
  resolves: Instruction[];
  close: Instruction;
  abort: Instruction;
}

function stageIx(programId: Uint8Array, ledger: Uint8Array, batch: Uint8Array, chunk: BatchItem[], index: number, proof: Uint8Array[]): Instruction {
  const escrows: Uint8Array[] = [];
  const eIdx = new Map<string, number>();
  for (const it of chunk) {
    const h = toHex(it.escrow);
    if (!eIdx.has(h)) {
      eIdx.set(h, 2 + escrows.length);
      escrows.push(it.escrow);
    }
  }
  const books: Uint8Array[] = [];
  const bIdx = new Map<string, number>();
  for (const it of chunk) {
    const h = toHex(it.book);
    if (!bIdx.has(h)) {
      bIdx.set(h, 2 + escrows.length + books.length);
      books.push(it.book);
    }
  }
  const wires = chunk.map((it) =>
    encodeWireVoucher({ escrowIx: eIdx.get(toHex(it.escrow))!, pairIx: it.pairIndex, bookIx: bIdx.get(toHex(it.book))!, slot: it.slot }, it.voucher),
  );
  return ix.stageChunk(programId, ledger, batch, escrows, books, index, proof, wires);
}

/** Largest chunk size whose StageChunk fits one V1 transaction for these
 * items (worst case over the chunks), capped at 32. */
export function chooseChunkSize(programId: Uint8Array, ledger: Uint8Array, submitter: Uint8Array, items: BatchItem[]): number {
  const dummy = new Uint8Array(32).fill(7);
  for (let size = Math.min(32, items.length); size >= 1; size--) {
    const chunks = Math.ceil(items.length / size);
    if (chunks > MAX_CHUNKS) break;
    let depth = 0;
    while (1 << depth < chunks) depth++;
    const proof = new Array<Uint8Array>(depth).fill(new Uint8Array(32));
    let ok = true;
    for (let c = 0; c < chunks && ok; c++) {
      const i = stageIx(programId, ledger, dummy, items.slice(c * size, (c + 1) * size), c, proof);
      ok = fitsV1(v1Size(submitter, [i]));
    }
    if (ok) return size;
  }
  throw new Error("a single voucher does not fit a StageChunk transaction");
}

/**
 * Builds every instruction of a two-phase batch.
 * - One voucher per (escrow, pair): pass only the latest per pair.
 * - At most 16 distinct (book, slot) payees.
 * - `batchId` should be random (nonzero); it names the batch PDA.
 */
export function buildTwoPhase(args: {
  programId: Uint8Array;
  ledger: Uint8Array;
  submitter: Uint8Array;
  batchId: bigint;
  items: BatchItem[];
  chunkSize?: number;
}): TwoPhasePlan {
  const { programId, ledger, submitter, batchId, items } = args;
  if (batchId === 0n) throw new Error("batchId must be nonzero");
  if (items.length === 0) throw new Error("empty batch");
  const pairs = new Set<string>();
  const payees = new Set<string>();
  for (const it of items) {
    const p = `${toHex(it.escrow)}:${it.pairIndex}`;
    if (pairs.has(p)) throw new Error("one voucher per escrow pair per batch");
    pairs.add(p);
    payees.add(`${toHex(it.book)}:${it.slot}`);
    if (it.delta <= 0n) throw new Error("delta must be positive");
  }
  if (payees.size > MAX_BATCH_PAYEES) throw new Error(`at most ${MAX_BATCH_PAYEES} payee slots per batch`);
  const chunkSize = args.chunkSize ?? chooseChunkSize(programId, ledger, submitter, items);
  let chunkLog = 0;
  while (1 << chunkLog < chunkSize) chunkLog++;
  if (chunkLog > MAX_CHUNK_LOG) throw new Error("chunk size above 32");
  const leaves = items.map((it) => batchLeaf(it.delta, voucherMessage(it.fields)));
  const tree = batchTree(leaves, chunkLog, chunkSize);
  if (tree.chunkRoots.length > MAX_CHUNKS) throw new Error("too many chunks");
  const [batch] = batchPda(programId, ledger, batchId);
  const total = items.reduce((s, it) => s + it.delta, 0n);
  const stages = tree.chunkRoots.map((_, c) => stageIx(programId, ledger, batch, items.slice(c * chunkSize, (c + 1) * chunkSize), c, tree.proof(c)));
  const books: Uint8Array[] = [];
  const seenBooks = new Set<string>();
  for (const it of items) {
    const h = toHex(it.book);
    if (!seenBooks.has(h)) {
      seenBooks.add(h);
      books.push(it.book);
    }
  }
  // Resolve: up to 30 escrow pairs per instruction.
  const resolves: Instruction[] = [];
  for (let i = 0; i < items.length; i += 30) {
    const part = items.slice(i, i + 30);
    const escrows: Uint8Array[] = [];
    const idx = new Map<string, number>();
    const entries: [number, number][] = part.map((it) => {
      const h = toHex(it.escrow);
      if (!idx.has(h)) {
        idx.set(h, 1 + escrows.length);
        escrows.push(it.escrow);
      }
      return [idx.get(h)!, it.pairIndex];
    });
    resolves.push(ix.resolveStaged(programId, batch, escrows, entries));
  }
  return {
    batch,
    root: tree.root,
    count: items.length,
    total,
    chunkLog,
    chunkSize,
    begin: ix.beginBatch(programId, ledger, submitter, batchId, tree.root, items.length, total, chunkLog, chunkSize),
    stages,
    commit: ix.commitBatch(programId, batch, books),
    resolves,
    close: ix.closeBatch(programId, batch, submitter),
    abort: ix.abortBatch(programId, batch, submitter),
  };
}
