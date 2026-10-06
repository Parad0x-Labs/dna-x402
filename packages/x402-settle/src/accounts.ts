// Account decoders (layouts in programs/x402_settle/src/state.rs).

import { b58encode, readU16, readU32, readU64 } from "./bytes.ts";

const DISC = {
  ledger: "x4sLEDGR",
  escrow: "x4sESCRW",
  book: "x4sBOOK_",
  channel: "x4sCHANL",
  batch: "x4sBATCH",
} as const;

function expect(d: Uint8Array, disc: string): void {
  if (d.length < 8 || new TextDecoder().decode(d.subarray(0, 8)) !== disc) throw new Error(`not a ${disc} account`);
}

export const LEDGER_LEN = 192;
export const ESCROW_HDR = 120;
export const PAIR_LEN = 56;
export const BOOK_HDR = 48;
export const SLOT_LEN = 40;
export const BOOK_SLOTS = 64;
export const CHANNEL_LEN = 168;
export const BATCH_HDR = 168;

export const CH_OPEN = 1;
export const CH_CLOSING = 2;
export const CH_CLOSED = 3;
export const B_STAGING = 1;
export const B_COMMITTED = 2;
export const B_ABORTED = 3;

export interface Ledger {
  bump: number;
  vaultBump: number;
  kind: number;
  decimals: number;
  mint: Uint8Array;
  tokenProgram: Uint8Array;
  vault: Uint8Array;
  salt: Uint8Array;
  exitDelaySlots: bigint;
  disputeSlots: bigint;
  batchTimeoutSlots: bigint;
  liabilities: bigint;
  nextScope: bigint;
  createdSlot: bigint;
}

export function decodeLedger(d: Uint8Array): Ledger {
  expect(d, DISC.ledger);
  return {
    bump: d[8]!,
    vaultBump: d[9]!,
    kind: d[10]!,
    decimals: d[11]!,
    mint: d.slice(16, 48),
    tokenProgram: d.slice(48, 80),
    vault: d.slice(80, 112),
    salt: d.slice(112, 144),
    exitDelaySlots: readU64(d, 144),
    disputeSlots: readU64(d, 152),
    batchTimeoutSlots: readU64(d, 160),
    liabilities: readU64(d, 168),
    nextScope: readU64(d, 176),
    createdSlot: readU64(d, 184),
  };
}

export interface Pair {
  payee: Uint8Array;
  settled: bigint;
  pendingCumulative: bigint;
  pendingBatch: bigint;
}

export interface Escrow {
  bump: number;
  capacity: number;
  pairCount: number;
  pendingCount: number;
  ledger: Uint8Array;
  payer: Uint8Array;
  scope: bigint;
  balance: bigint;
  exitAmount: bigint;
  exitReadySlot: bigint;
  openChannels: number;
  pairs: Pair[];
}

export function decodeEscrow(d: Uint8Array): Escrow {
  expect(d, DISC.escrow);
  const pairCount = d[11]!;
  const pairs: Pair[] = [];
  for (let i = 0; i < pairCount; i++) {
    const o = ESCROW_HDR + i * PAIR_LEN;
    pairs.push({ payee: d.slice(o, o + 32), settled: readU64(d, o + 32), pendingCumulative: readU64(d, o + 40), pendingBatch: readU64(d, o + 48) });
  }
  return {
    bump: d[8]!,
    capacity: d[10]!,
    pairCount,
    pendingCount: readU16(d, 12),
    ledger: d.slice(16, 48),
    payer: d.slice(48, 80),
    scope: readU64(d, 80),
    balance: readU64(d, 88),
    exitAmount: readU64(d, 96),
    exitReadySlot: readU64(d, 104),
    openChannels: readU32(d, 112),
    pairs,
  };
}

/** Pair index for `payee` in an escrow: its entry, or the next free index (an append). */
export function pairIndexFor(e: Escrow, payee: Uint8Array): { index: number; append: boolean; settled: bigint } {
  const hex = b58encode(payee);
  const i = e.pairs.findIndex((p) => b58encode(p.payee) === hex);
  if (i >= 0) return { index: i, append: false, settled: e.pairs[i]!.settled };
  if (e.pairCount >= e.capacity) throw new Error("escrow pair table full: grow the escrow");
  return { index: e.pairCount, append: true, settled: 0n };
}

export interface BookSlot {
  owner: Uint8Array;
  balance: bigint;
}

export function decodeBook(d: Uint8Array): { bump: number; used: number; page: number; ledger: Uint8Array; slots: BookSlot[] } {
  expect(d, DISC.book);
  const slots: BookSlot[] = [];
  for (let i = 0; i < BOOK_SLOTS; i++) {
    const o = BOOK_HDR + i * SLOT_LEN;
    slots.push({ owner: d.slice(o, o + 32), balance: readU64(d, o + 32) });
  }
  return { bump: d[8]!, used: readU16(d, 10), page: readU32(d, 12), ledger: d.slice(16, 48), slots };
}

export interface Channel {
  bump: number;
  status: number;
  ledger: Uint8Array;
  payer: Uint8Array;
  payee: Uint8Array;
  channelId: bigint;
  scope: bigint;
  deposit: bigint;
  balance: bigint;
  bestCumulative: bigint;
  expirySlot: bigint;
  disputeEndSlot: bigint;
}

export function decodeChannel(d: Uint8Array): Channel {
  expect(d, DISC.channel);
  return {
    bump: d[8]!,
    status: d[9]!,
    ledger: d.slice(16, 48),
    payer: d.slice(48, 80),
    payee: d.slice(80, 112),
    channelId: readU64(d, 112),
    scope: readU64(d, 120),
    deposit: readU64(d, 128),
    balance: readU64(d, 136),
    bestCumulative: readU64(d, 144),
    expirySlot: readU64(d, 152),
    disputeEndSlot: readU64(d, 160),
  };
}

export interface BatchHeader {
  bump: number;
  status: number;
  chunkLog: number;
  chunkSize: number;
  nPayees: number;
  numChunks: number;
  chunksStaged: number;
  outstanding: number;
  ledger: Uint8Array;
  submitter: Uint8Array;
  batchId: bigint;
  root: Uint8Array;
  count: number;
  stagedCount: number;
  total: bigint;
  stagedTotal: bigint;
  held: bigint;
  deadlineSlot: bigint;
}

export function decodeBatch(d: Uint8Array): BatchHeader {
  expect(d, DISC.batch);
  return {
    bump: d[8]!,
    status: d[9]!,
    chunkLog: d[10]!,
    chunkSize: d[11]!,
    nPayees: d[12]!,
    numChunks: readU16(d, 13),
    chunksStaged: readU16(d, 15),
    outstanding: readU32(d, 17),
    ledger: d.slice(24, 56),
    submitter: d.slice(56, 88),
    batchId: readU64(d, 88),
    root: d.slice(96, 128),
    count: readU32(d, 128),
    stagedCount: readU32(d, 132),
    total: readU64(d, 136),
    stagedTotal: readU64(d, 144),
    held: readU64(d, 152),
    deadlineSlot: readU64(d, 160),
  };
}

export const ERROR_BASE = 0x5853_0000;
export const ERROR_NAMES = [
  "",
  "InvalidInstruction",
  "InvalidAccount",
  "AccountInUse",
  "MintNotAllowed",
  "Unauthorized",
  "InsufficientFunds",
  "MathOverflow",
  "BadSignature",
  "VoucherExpired",
  "StaleVoucher",
  "PairPending",
  "PairMismatch",
  "PairTableFull",
  "SlotMismatch",
  "ExitNotReady",
  "EscrowBusy",
  "InvalidPayerKey",
  "ChannelState",
  "ChannelExpired",
  "ChannelNotExpired",
  "DisputeOpen",
  "OverDeposit",
  "BatchState",
  "BatchDeadline",
  "BatchNotTimedOut",
  "ChunkAlreadyStaged",
  "BadChunk",
  "BadMerkleProof",
  "BatchIncomplete",
  "BatchTotalMismatch",
  "BatchPayeesFull",
  "BatchOutstanding",
  "Insolvent",
  "InvalidParams",
  "WrongPendingBatch",
  "DuplicatePair",
] as const;

export function errorName(code: number): string | undefined {
  const i = code - ERROR_BASE;
  return i > 0 && i < ERROR_NAMES.length ? ERROR_NAMES[i] : undefined;
}
