/**
 * chain.ts — read-only Solana queries for the .null portal.
 *
 * All functions here are read-only (getAccountInfo / getProgramAccounts /
 * getTokenAccountBalance). Nothing here sends a transaction.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  REGISTRAR_PROGRAM,
  NULL_MINT,
  TOKEN_2022_PROGRAM,
  NULL_DOMAIN_DISC,
  ND_OFF_OWNER,
  domainPda,
  ataOf,
} from "./null-sdk";

export const DEFAULT_RPC =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";

export function getConnection(): Connection {
  return new Connection(DEFAULT_RPC, "confirmed");
}

export type Availability =
  | { status: "available"; pda: string }
  | { status: "taken"; pda: string; owner: string | null };

/**
 * Derive domainPda(name) and getAccountInfo. If no account → AVAILABLE.
 * If an account exists and looks like a NullDomain (disc 0x4e) → TAKEN, and we
 * decode the owner pubkey @ offset 65.
 */
export async function checkAvailability(
  conn: Connection,
  name: string,
): Promise<Availability> {
  const pda = await domainPda(name);
  const info = await conn.getAccountInfo(pda);
  const pdaStr = pda.toBase58();
  if (!info || info.data.length === 0) {
    return { status: "available", pda: pdaStr };
  }
  const data = info.data;
  // A real NullDomain record begins with disc 'N' (0x4e) and is long enough to
  // hold the owner pubkey at offset 65. Anything else we treat as taken-unknown.
  let owner: string | null = null;
  if (data[0] === NULL_DOMAIN_DISC && data.length >= ND_OFF_OWNER + 32) {
    owner = new PublicKey(data.subarray(ND_OFF_OWNER, ND_OFF_OWNER + 32)).toBase58();
  }
  return { status: "taken", pda: pdaStr, owner };
}

export interface OwnedName {
  name: string;
  pda: string;
  owner: string;
}

/** Decode the plaintext .null name from a NullDomain account: the 64-byte name
 *  field lives at offset 1 (printable chars before the first 0x00). */
function decodeName(data: Uint8Array): string {
  const raw = data.subarray(1, 65);
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(raw[i]);
  return s;
}

/**
 * getProgramAccounts on the registrar with a memcmp filter on the owner field
 * (NullDomain owner @ offset 65 == the connected wallet). Returns the PDA list.
 *
 * The plaintext name IS stored on-chain (64-byte name field @ offset 1), so we
 * decode + return it — each owned domain shows as its real name, e.g. "chat".
 */
export async function getOwnedNames(
  conn: Connection,
  owner: PublicKey,
): Promise<OwnedName[]> {
  const accounts = await conn.getProgramAccounts(REGISTRAR_PROGRAM, {
    // memcmp on the owner field @ offset 65 == the connected wallet. The disc
    // ('N' @ byte 0) is re-checked client-side below so we never surface a
    // non-NullDomain account that happens to share these bytes.
    filters: [{ memcmp: { offset: ND_OFF_OWNER, bytes: owner.toBase58() } }],
  });

  return accounts
    .filter((a) => a.account.data.length > 0 && a.account.data[0] === NULL_DOMAIN_DISC)
    .map((a) => ({
      name: decodeName(a.account.data),
      pda: a.pubkey.toBase58(),
      owner: owner.toBase58(),
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** Read the connected wallet's $NULL balance (atomic) from its Token-2022 ATA.
 *  Returns 0n if the ATA does not exist. */
export async function getNullBalanceAtomic(
  conn: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const ata = ataOf(owner, NULL_MINT, TOKEN_2022_PROGRAM);
  const info = await conn.getAccountInfo(ata);
  if (!info) return 0n;
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}
