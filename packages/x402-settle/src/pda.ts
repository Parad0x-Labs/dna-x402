// Program-derived addresses and the seeds of every x402_settle account.

import { sha256, u32le, u64le } from "./bytes.ts";
import { isOnCurve } from "./ed25519.ts";

const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array | null {
  if (seeds.length > 16 || seeds.some((s) => s.length > 32)) throw new Error("invalid seeds");
  const h = sha256(...seeds, programId, MARKER);
  return isOnCurve(h) ? null : h;
}

/** Canonical bump search (255 down to 0), as `Pubkey::find_program_address`. */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): [Uint8Array, number] {
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (a) return [a, bump];
  }
  throw new Error("no program address");
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Mint seed of the SOL ledger. */
export const SOL_MINT = new Uint8Array(32);

export const ledgerPda = (programId: Uint8Array, mint: Uint8Array) => findProgramAddress([enc("ledger"), mint], programId);
export const vaultPda = (programId: Uint8Array, ledger: Uint8Array) => findProgramAddress([enc("vault"), ledger], programId);
export const escrowPda = (programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array) =>
  findProgramAddress([enc("escrow"), ledger, payer], programId);
export const bookPda = (programId: Uint8Array, ledger: Uint8Array, page: number) =>
  findProgramAddress([enc("book"), ledger, u32le(page)], programId);
export const channelPda = (programId: Uint8Array, ledger: Uint8Array, payer: Uint8Array, payee: Uint8Array, channelId: bigint) =>
  findProgramAddress([enc("channel"), ledger, payer, payee, u64le(channelId)], programId);
export const batchPda = (programId: Uint8Array, ledger: Uint8Array, batchId: bigint) =>
  findProgramAddress([enc("batch"), ledger, u64le(batchId)], programId);

