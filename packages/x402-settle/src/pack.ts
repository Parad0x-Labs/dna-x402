// Transaction packers: lane B2 settles, lane C batch closes and client-side
// fan-out, each split into the fewest V1 transactions that fit 4,096 bytes
// and 64 addresses.

import { b58encode, toHex } from "./bytes.ts";
import * as ix from "./instructions.ts";
import type { Instruction } from "./instructions.ts";
import { encodeWireClose, encodeWireVoucher, type SignedVoucher } from "./voucher.ts";
import { fitsV1, v1Size } from "./v1.ts";

/** One B2 voucher with the accounts it settles against. */
export interface SettleItem {
  escrow: Uint8Array;
  /** Index of the payer-payee pair in the escrow (`pairIndexFor`). */
  pairIndex: number;
  book: Uint8Array;
  slot: number;
  voucher: Pick<SignedVoucher, "cumulative" | "expirySlot" | "quoteHash" | "signature">;
}

/** Index lookup that keeps insertion order. */
class KeyList {
  keys: Uint8Array[] = [];
  private idx = new Map<string, number>();
  private readonly base: number;
  constructor(base: number) {
    this.base = base;
  }
  at(k: Uint8Array): number {
    const h = toHex(k);
    let i = this.idx.get(h);
    if (i === undefined) {
      i = this.base + this.keys.length;
      this.keys.push(k);
      this.idx.set(h, i);
    }
    return i;
  }
}

/** One Settle instruction for `items` (all on `ledger`). */
export function settleInstruction(programId: Uint8Array, ledger: Uint8Array, items: SettleItem[]): Instruction {
  if (items.length === 0 || items.length > 255) throw new Error("1..255 vouchers per instruction");
  const keys = new KeyList(1);
  const wires = items.map((it) =>
    encodeWireVoucher({ escrowIx: keys.at(it.escrow), pairIx: it.pairIndex, bookIx: keys.at(it.book), slot: it.slot }, it.voucher),
  );
  return ix.settle(programId, ledger, keys.keys, wires);
}

/** Greedy split of `items` into Settle instructions, one per V1 transaction
 * paid by `feePayer`. Items keep their order (vouchers of one pair must
 * appear in rising cumulative order). */
export function packSettle(programId: Uint8Array, ledger: Uint8Array, feePayer: Uint8Array, items: SettleItem[]): Instruction[] {
  const out: Instruction[] = [];
  let cur: SettleItem[] = [];
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length && !fitsV1(v1Size(feePayer, [settleInstruction(programId, ledger, next)]))) {
      out.push(settleInstruction(programId, ledger, cur));
      cur = [it];
    } else {
      cur = next;
    }
  }
  if (cur.length) out.push(settleInstruction(programId, ledger, cur));
  for (const i of out) {
    if (!fitsV1(v1Size(feePayer, [i]))) throw new Error("a single voucher does not fit a V1 transaction");
  }
  return out;
}

/** Keeps only the highest cumulative voucher per (escrow, pair): earlier
 * vouchers of a pair are implied by the latest one. */
export function latestPerPair(items: SettleItem[]): SettleItem[] {
  const best = new Map<string, SettleItem>();
  for (const it of items) {
    const k = `${toHex(it.escrow)}:${it.pairIndex}`;
    const b = best.get(k);
    if (!b || it.voucher.cumulative > b.voucher.cumulative) best.set(k, it);
  }
  return [...best.values()];
}

/** One channel close with the accounts it needs. */
export interface CloseItem {
  channel: Uint8Array;
  /** The payee's book and slot (needed when the payee signs). */
  book?: Uint8Array;
  slot: number;
  voucher: Pick<SignedVoucher, "cumulative" | "expirySlot" | "quoteHash" | "signature">;
}

export function closeChannelsInstruction(programId: Uint8Array, ledger: Uint8Array, items: CloseItem[], payeeSigners: Uint8Array[]): Instruction {
  const keys = new KeyList(1);
  const wires = items.map((it) =>
    encodeWireClose({ channelIx: keys.at(it.channel), bookIx: it.book ? keys.at(it.book) : 0xff, slot: it.slot }, it.voucher),
  );
  return ix.closeChannels(programId, ledger, keys.keys, payeeSigners, wires);
}

/** Batch closes for one payee (who signs and pays the fee), split per V1 transaction. */
export function packCloseChannels(programId: Uint8Array, ledger: Uint8Array, payee: Uint8Array, items: CloseItem[]): Instruction[] {
  const out: Instruction[] = [];
  let cur: CloseItem[] = [];
  const build = (xs: CloseItem[]) => closeChannelsInstruction(programId, ledger, xs, [payee]);
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length && !fitsV1(v1Size(payee, [build(next)]))) {
      out.push(build(cur));
      cur = [it];
    } else {
      cur = next;
    }
  }
  if (cur.length) out.push(build(cur));
  return out;
}

/** Fan-out: one source pays many existing token accounts. The program adds
 * nothing here (a CPI per payment costs trace entries and CU), so this is a
 * plain V1 multi-transfer: up to 60 TransferChecked per transaction. */
export function packFanOut(
  owner: Uint8Array,
  tokenProgram: Uint8Array,
  mint: Uint8Array,
  source: Uint8Array,
  decimals: number,
  transfers: { destination: Uint8Array; amount: bigint }[],
): Instruction[][] {
  const txs: Instruction[][] = [];
  let cur: Instruction[] = [];
  for (const t of transfers) {
    const i = ix.transferChecked(tokenProgram, source, mint, t.destination, owner, t.amount, decimals);
    const next = [...cur, i];
    if (cur.length && !fitsV1(v1Size(owner, next))) {
      txs.push(cur);
      cur = [i];
    } else {
      cur = next;
    }
  }
  if (cur.length) txs.push(cur);
  return txs;
}

export const keyString = (k: Uint8Array): string => b58encode(k);
