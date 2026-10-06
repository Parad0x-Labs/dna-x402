// SIMD-0385 Transaction V1: message compilation, serialization, signing and
// size checks. No address lookup tables exist in V1; the compute-unit limit
// and the loaded-data size travel in the config mask instead of compute
// budget instructions. Layout (as measured on devnet by the spike):
//
//   129 | num_required_sigs | num_readonly_signed | num_readonly_unsigned |
//   config mask u32 | blockhash 32 | num_ix u8 | num_addresses u8 |
//   addresses 32*n | config values | per ix: program index u8, account count
//   u8, data length u16 | per ix: account indexes, data | signatures 64*s
//
// Account order follows solana-sdk's legacy compiler: fee payer, then
// writable signers, read-only signers, writable non-signers, read-only
// non-signers, each group sorted by address bytes.

import { compare, concat, toHex, u16le, u32le, u64le } from "./bytes.ts";
import type { Signer } from "./ed25519.ts";
import type { Instruction } from "./instructions.ts";

export const V1_MAX_BYTES = 4096;
export const V1_MAX_ADDRESSES = 64;
export const V1_MAX_SIGNATURES = 12;
export const V1_MAX_INSTRUCTIONS = 64;

export interface CompiledMessage {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: Uint8Array[];
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
}

export function compileMessage(payer: Uint8Array, ixs: Instruction[]): CompiledMessage {
  const meta = new Map<string, { key: Uint8Array; signer: boolean; writable: boolean }>();
  const touch = (k: Uint8Array) => {
    const h = toHex(k);
    let m = meta.get(h);
    if (!m) {
      m = { key: k, signer: false, writable: false };
      meta.set(h, m);
    }
    return m;
  };
  for (const ix of ixs) {
    touch(ix.programId);
    for (const a of ix.keys) {
      const m = touch(a.pubkey);
      m.signer ||= a.isSigner;
      m.writable ||= a.isWritable;
    }
  }
  meta.delete(toHex(payer));
  const rest = [...meta.values()].sort((a, b) => compare(a.key, b.key));
  const ws = rest.filter((m) => m.signer && m.writable).map((m) => m.key);
  const rs = rest.filter((m) => m.signer && !m.writable).map((m) => m.key);
  const wn = rest.filter((m) => !m.signer && m.writable).map((m) => m.key);
  const rn = rest.filter((m) => !m.signer && !m.writable).map((m) => m.key);
  const accountKeys = [payer, ...ws, ...rs, ...wn, ...rn];
  const index = new Map(accountKeys.map((k, i) => [toHex(k), i]));
  const at = (k: Uint8Array) => index.get(toHex(k))!;
  return {
    numRequiredSignatures: 1 + ws.length + rs.length,
    numReadonlySigned: rs.length,
    numReadonlyUnsigned: rn.length,
    accountKeys,
    instructions: ixs.map((ix) => ({ programIdIndex: at(ix.programId), accounts: ix.keys.map((a) => at(a.pubkey)), data: ix.data })),
  };
}

export interface V1Config {
  computeUnitLimit: number;
  loadedAccountsDataSize: number;
  /** Total priority fee in lamports (optional). */
  priorityFeeLamports?: bigint;
}

export const DEFAULT_V1_CONFIG: V1Config = { computeUnitLimit: 1_400_000, loadedAccountsDataSize: 1 << 20 };

/** The bytes the signers sign. */
export function serializeV1Message(msg: CompiledMessage, blockhash: Uint8Array, cfg: V1Config = DEFAULT_V1_CONFIG): Uint8Array {
  if (blockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  let mask = (1 << 2) | (1 << 3);
  const cfgBytes: Uint8Array[] = [];
  if (cfg.priorityFeeLamports && cfg.priorityFeeLamports > 0n) {
    mask |= 0b11;
    cfgBytes.push(u64le(cfg.priorityFeeLamports));
  }
  cfgBytes.push(u32le(cfg.computeUnitLimit), u32le(cfg.loadedAccountsDataSize));
  const parts: Uint8Array[] = [
    Uint8Array.of(129, msg.numRequiredSignatures, msg.numReadonlySigned, msg.numReadonlyUnsigned),
    u32le(mask),
    blockhash,
    Uint8Array.of(msg.instructions.length, msg.accountKeys.length),
    ...msg.accountKeys,
    ...cfgBytes,
  ];
  for (const ix of msg.instructions) parts.push(Uint8Array.of(ix.programIdIndex, ix.accounts.length), u16le(ix.data.length));
  for (const ix of msg.instructions) parts.push(Uint8Array.from(ix.accounts), ix.data);
  return concat(...parts);
}

/** Message followed by one signature per required signer, in account order. */
export function signV1(message: Uint8Array, msg: CompiledMessage, signers: Signer[]): Uint8Array {
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < msg.numRequiredSignatures; i++) {
    const k = msg.accountKeys[i]!;
    const s = signers.find((x) => compare(x.publicKey, k) === 0);
    if (!s) throw new Error(`missing signer ${toHex(k)}`);
    sigs.push(s.sign(message));
  }
  return concat(message, ...sigs);
}

export function buildV1Transaction(payer: Signer, ixs: Instruction[], blockhash: Uint8Array, signers: Signer[] = [], cfg: V1Config = DEFAULT_V1_CONFIG): Uint8Array {
  const msg = compileMessage(payer.publicKey, ixs);
  const m = serializeV1Message(msg, blockhash, cfg);
  const tx = signV1(m, msg, [payer, ...signers]);
  checkV1Limits(msg, tx.length);
  return tx;
}

export interface V1Size {
  bytes: number;
  addresses: number;
  signatures: number;
  instructions: number;
}

export function v1Size(payer: Uint8Array, ixs: Instruction[], cfg: V1Config = DEFAULT_V1_CONFIG): V1Size {
  const msg = compileMessage(payer, ixs);
  const priority = cfg.priorityFeeLamports && cfg.priorityFeeLamports > 0n ? 8 : 0;
  let bytes = 1 + 3 + 4 + 32 + 1 + 1 + 32 * msg.accountKeys.length + 8 + priority + 64 * msg.numRequiredSignatures;
  for (const ix of msg.instructions) bytes += 4 + ix.accounts.length + ix.data.length;
  return { bytes, addresses: msg.accountKeys.length, signatures: msg.numRequiredSignatures, instructions: msg.instructions.length };
}

export function fitsV1(s: V1Size): boolean {
  return (
    s.bytes <= V1_MAX_BYTES &&
    s.addresses <= V1_MAX_ADDRESSES &&
    s.signatures <= V1_MAX_SIGNATURES &&
    s.instructions <= V1_MAX_INSTRUCTIONS
  );
}

function checkV1Limits(msg: CompiledMessage, bytes: number): void {
  const s: V1Size = { bytes, addresses: msg.accountKeys.length, signatures: msg.numRequiredSignatures, instructions: msg.instructions.length };
  if (!fitsV1(s)) throw new Error(`V1 limits exceeded: ${JSON.stringify(s)}`);
}
