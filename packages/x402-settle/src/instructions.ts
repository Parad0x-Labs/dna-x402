// Instruction builders. Account order and data layout mirror
// programs/x402_settle/src/instruction.rs; the program id always comes from
// the caller's configuration.

import { b58decode, concat, u16le, u32le, u64le } from "./bytes.ts";
import { batchPda, bookPda, channelPda, escrowPda, ledgerPda, SOL_MINT, vaultPda } from "./pda.ts";

export interface AccountMeta {
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Uint8Array;
  keys: AccountMeta[];
  data: Uint8Array;
}

export const SYSTEM_PROGRAM_ID = new Uint8Array(32);
export const SLOT_HASHES_ID = b58decode("SysvarS1otHashes111111111111111111111111111");
export const TOKEN_PROGRAM_ID = b58decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = b58decode("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export const KIND_SOL = 0;
export const KIND_TOKEN = 1;
export const KIND_TOKEN_2022 = 2;

export const TAG = {
  INIT_LEDGER: 0,
  OPEN_ESCROW: 1,
  GROW_ESCROW: 2,
  DEPOSIT: 3,
  REQUEST_EXIT: 4,
  WITHDRAW_ESCROW: 5,
  CLOSE_ESCROW: 6,
  CREATE_BOOK: 7,
  REGISTER_PAYEE: 8,
  WITHDRAW_PAYEE: 9,
  SETTLE: 10,
  OPEN_CHANNEL: 11,
  CLOSE_CHANNELS: 12,
  REQUEST_CHANNEL_CLOSE: 13,
  FINALIZE_CHANNEL: 14,
  RECLAIM_CHANNEL: 15,
  BEGIN_BATCH: 16,
  STAGE_CHUNK: 17,
  COMMIT_BATCH: 18,
  ABORT_BATCH: 19,
  RESOLVE_STAGED: 20,
  CLOSE_BATCH: 21,
} as const;

const w = (pubkey: Uint8Array, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: Uint8Array, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

/** Token accounts appended to SPL deposits and withdrawals. */
export interface SplAccounts {
  vault: Uint8Array;
  mint: Uint8Array;
  tokenProgram: Uint8Array;
}

const withSpl = (keys: AccountMeta[], spl?: SplAccounts): AccountMeta[] =>
  spl ? [...keys, w(spl.vault), r(spl.mint), r(spl.tokenProgram)] : keys;

export function initLedgerSol(programId: Uint8Array, funder: Uint8Array): Instruction {
  const [ledger] = ledgerPda(programId, SOL_MINT);
  return {
    programId,
    keys: [w(funder, true), w(ledger), r(SYSTEM_PROGRAM_ID), r(SLOT_HASHES_ID)],
    data: Uint8Array.of(TAG.INIT_LEDGER, KIND_SOL),
  };
}

export function initLedgerSpl(programId: Uint8Array, funder: Uint8Array, mint: Uint8Array, tokenProgram: Uint8Array, kind: number): Instruction {
  const [ledger] = ledgerPda(programId, mint);
  const [vault] = vaultPda(programId, ledger);
  return {
    programId,
    keys: [w(funder, true), w(ledger), r(mint), w(vault), r(tokenProgram), r(SYSTEM_PROGRAM_ID), r(SLOT_HASHES_ID)],
    data: Uint8Array.of(TAG.INIT_LEDGER, kind),
  };
}

export function openEscrow(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, capacity: number): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: [w(payer, true), w(ledger), w(escrow), r(SYSTEM_PROGRAM_ID)], data: Uint8Array.of(TAG.OPEN_ESCROW, capacity) };
}

export function growEscrow(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, capacity: number): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: [w(payer, true), w(escrow), r(SYSTEM_PROGRAM_ID)], data: Uint8Array.of(TAG.GROW_ESCROW, capacity) };
}

/** `spl` = (depositor's source token account, token accounts) for an SPL ledger. */
export function deposit(
  programId: Uint8Array,
  ledger: Uint8Array,
  depositor: Uint8Array,
  payer: Uint8Array,
  amount: bigint,
  spl?: { source: Uint8Array } & SplAccounts,
): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  const data = concat(Uint8Array.of(TAG.DEPOSIT), u64le(amount));
  const keys = spl
    ? [r(depositor, true), w(ledger), w(escrow), w(spl.source), w(spl.vault), r(spl.mint), r(spl.tokenProgram)]
    : [w(depositor, true), w(ledger), w(escrow), r(SYSTEM_PROGRAM_ID)];
  return { programId, keys, data };
}

export function requestExit(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, amount: bigint): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: [r(payer, true), r(ledger), w(escrow)], data: concat(Uint8Array.of(TAG.REQUEST_EXIT), u64le(amount)) };
}

export function withdrawEscrow(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, destination: Uint8Array, spl?: SplAccounts): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: withSpl([r(payer, true), w(ledger), w(escrow), w(destination)], spl), data: Uint8Array.of(TAG.WITHDRAW_ESCROW) };
}

export function closeEscrow(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: [w(payer, true), w(escrow)], data: Uint8Array.of(TAG.CLOSE_ESCROW) };
}

export function createBook(programId: Uint8Array, ledger: Uint8Array, funder: Uint8Array, page: number): Instruction {
  const [book] = bookPda(programId, ledger, page);
  return { programId, keys: [w(funder, true), r(ledger), w(book), r(SYSTEM_PROGRAM_ID)], data: concat(Uint8Array.of(TAG.CREATE_BOOK), u32le(page)) };
}

export function registerPayee(programId: Uint8Array, book: Uint8Array, payee: Uint8Array, slot: number): Instruction {
  return { programId, keys: [r(payee, true), w(book)], data: Uint8Array.of(TAG.REGISTER_PAYEE, slot) };
}

export function withdrawPayee(
  programId: Uint8Array,
  ledger: Uint8Array,
  book: Uint8Array,
  payee: Uint8Array,
  slot: number,
  amount: bigint,
  destination: Uint8Array,
  spl?: SplAccounts,
): Instruction {
  return {
    programId,
    keys: withSpl([r(payee, true), w(ledger), w(book), w(destination)], spl),
    data: concat(Uint8Array.of(TAG.WITHDRAW_PAYEE, slot), u64le(amount)),
  };
}

/** Settle: account 0 = ledger, then the escrows and books the wire vouchers index (from 1). */
export function settle(programId: Uint8Array, ledger: Uint8Array, accounts: Uint8Array[], wireVouchers: Uint8Array[]): Instruction {
  return {
    programId,
    keys: [r(ledger), ...accounts.map((k) => w(k))],
    data: concat(Uint8Array.of(TAG.SETTLE, wireVouchers.length), ...wireVouchers),
  };
}

export function openChannel(
  programId: Uint8Array,
  ledger: Uint8Array,
  payer: Uint8Array,
  payee: Uint8Array,
  channelId: bigint,
  amount: bigint,
  expirySlot: bigint,
): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  const [channel] = channelPda(programId, ledger, payer, payee, channelId);
  return {
    programId,
    keys: [w(payer, true), w(ledger), w(escrow), w(channel), r(SYSTEM_PROGRAM_ID)],
    data: concat(Uint8Array.of(TAG.OPEN_CHANNEL), u64le(channelId), payee, u64le(amount), u64le(expirySlot)),
  };
}

/** CloseChannels: account 0 = ledger, `writable` (channels and books, indexed from 1), then payee signers. */
export function closeChannels(programId: Uint8Array, ledger: Uint8Array, writable: Uint8Array[], signers: Uint8Array[], wireCloses: Uint8Array[]): Instruction {
  return {
    programId,
    keys: [r(ledger), ...writable.map((k) => w(k)), ...signers.map((k) => r(k, true))],
    data: concat(Uint8Array.of(TAG.CLOSE_CHANNELS, wireCloses.length), ...wireCloses),
  };
}

export function requestChannelClose(programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, channel: Uint8Array): Instruction {
  return { programId, keys: [r(payer, true), r(ledger), w(channel)], data: Uint8Array.of(TAG.REQUEST_CHANNEL_CLOSE) };
}

export function finalizeChannel(programId: Uint8Array, channel: Uint8Array, book?: { book: Uint8Array; slot: number }, payeeSigner?: Uint8Array): Instruction {
  const keys = [w(channel)];
  if (book) keys.push(w(book.book));
  if (payeeSigner) keys.push(r(payeeSigner, true));
  return { programId, keys, data: Uint8Array.of(TAG.FINALIZE_CHANNEL, book?.slot ?? 0) };
}

export function reclaimChannel(programId: Uint8Array, ledger: Uint8Array, channel: Uint8Array, payer: Uint8Array): Instruction {
  const [escrow] = escrowPda(programId, ledger, payer);
  return { programId, keys: [w(channel), w(escrow), w(payer)], data: Uint8Array.of(TAG.RECLAIM_CHANNEL) };
}

export function beginBatch(
  programId: Uint8Array,
  ledger: Uint8Array,
  submitter: Uint8Array,
  batchId: bigint,
  root: Uint8Array,
  count: number,
  total: bigint,
  chunkLog: number,
  chunkSize: number,
): Instruction {
  const [batch] = batchPda(programId, ledger, batchId);
  return {
    programId,
    keys: [w(submitter, true), r(ledger), w(batch), r(SYSTEM_PROGRAM_ID)],
    data: concat(Uint8Array.of(TAG.BEGIN_BATCH), u64le(batchId), root, u32le(count), u64le(total), Uint8Array.of(chunkLog, chunkSize)),
  };
}

/** StageChunk: 0 = ledger, 1 = batch, escrows (writable, from 2), then books (read-only). */
export function stageChunk(
  programId: Uint8Array,
  ledger: Uint8Array,
  batch: Uint8Array,
  escrows: Uint8Array[],
  books: Uint8Array[],
  chunkIndex: number,
  proof: Uint8Array[],
  wireVouchers: Uint8Array[],
): Instruction {
  return {
    programId,
    keys: [r(ledger), w(batch), ...escrows.map((k) => w(k)), ...books.map((k) => r(k))],
    data: concat(Uint8Array.of(TAG.STAGE_CHUNK), u16le(chunkIndex), Uint8Array.of(wireVouchers.length, proof.length), ...proof, ...wireVouchers),
  };
}

export function commitBatch(programId: Uint8Array, batch: Uint8Array, books: Uint8Array[]): Instruction {
  return { programId, keys: [w(batch), ...books.map((k) => w(k))], data: Uint8Array.of(TAG.COMMIT_BATCH) };
}

export function abortBatch(programId: Uint8Array, batch: Uint8Array, caller: Uint8Array): Instruction {
  return { programId, keys: [r(caller, true), w(batch)], data: Uint8Array.of(TAG.ABORT_BATCH) };
}

/** ResolveStaged: 0 = batch, escrows from 1; entries are [escrowIx, pairIx]. */
export function resolveStaged(programId: Uint8Array, batch: Uint8Array, escrows: Uint8Array[], entries: [number, number][]): Instruction {
  return {
    programId,
    keys: [w(batch), ...escrows.map((k) => w(k))],
    data: concat(Uint8Array.of(TAG.RESOLVE_STAGED, entries.length), ...entries.map(([e, p]) => Uint8Array.of(e, p))),
  };
}

export function closeBatch(programId: Uint8Array, batch: Uint8Array, submitter: Uint8Array): Instruction {
  return { programId, keys: [w(batch), w(submitter)], data: Uint8Array.of(TAG.CLOSE_BATCH) };
}

/** SPL TransferChecked (tag 12), for client-built fan-out. */
export function transferChecked(
  tokenProgram: Uint8Array,
  source: Uint8Array,
  mint: Uint8Array,
  destination: Uint8Array,
  owner: Uint8Array,
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programId: tokenProgram,
    keys: [w(source), r(mint), w(destination), r(owner, true)],
    data: concat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)),
  };
}
