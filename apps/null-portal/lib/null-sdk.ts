/**
 * null-sdk.ts — TypeScript port of the mainnet-verified .null registrar SDK.
 *
 * PORTED VERBATIM (byte-for-byte) from the live go-live scripts in
 * web0-internal: scripts/mainnet-rollout/_lib.mjs + 06_verify.mjs. Every
 * constant, seed, PDA derivation, hash, and instruction layout below is
 * mainnet-correct as verified on-chain 2026-06-08. Do NOT change the byte
 * layouts — they are what the deployed program H4wbFJ… expects.
 *
 * This module is isomorphic: it uses @solana/web3.js for keys/PDAs and the
 * Web Crypto SubtleCrypto API for sha256 so it runs unchanged in the browser
 * AND in Node (Node 18+ exposes globalThis.crypto.subtle).
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

// ── Canonical mainnet ids (verified on-chain — DO NOT EDIT) ───────────────────
export const REGISTRAR_PROGRAM = new PublicKey(
  "H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm",
);
export const AUCTION_PROGRAM = new PublicKey(
  "7uxLhqLzkEzPpkvdmTwqgL3g66yq2aMBS5QgcjaZZEaw",
);
export const CONFIG_PDA_EXPECTED = new PublicKey(
  "BQTxsYxocM2ZC3Wb2pVdnyzTPduBcNhKojhBenR6AXYG",
);
/** Authority == Treasury == upgrade-authority for both programs. */
export const AUTHORITY = new PublicKey(
  "F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY",
);
export const TREASURY = AUTHORITY; // same wallet by design
/** Real $NULL mint — a Token-2022 mint. */
export const NULL_MINT = new PublicKey(
  "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump",
);
export const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const ATA_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// ── Target fee (the on-chain target; read the LIVE value from config) ─────────
export const SOL_FEE_LAMPORTS = 7_000_000; // 0.007 SOL

// ── Instruction discriminants ─────────────────────────────────────────────────
export const IX_REGISTER = 0x02; // registrar Register
export const CURRENCY_SOL = 1;
export const CURRENCY_NULL = 3;

// ── PDA seeds ─────────────────────────────────────────────────────────────────
export const REGISTRY_SEED = new TextEncoder().encode("null-registry");
export const DOMAIN_SEED = new TextEncoder().encode("null-domain");

// ── RegistryConfig (v2 — 122 bytes) field offsets (mirror state.rs EXACTLY) ───
export const REGISTRY_CONFIG_SIZE = 122;
export const REGISTRY_CONFIG_DISC = 0x52; // 'R'
export const RC_OFF_DISC = 0,
  RC_OFF_AUTHORITY = 1,
  RC_OFF_SOL_FEE = 33,
  RC_OFF_NULL_FEE = 41,
  RC_OFF_NULL_MINT = 49,
  RC_OFF_TREASURY = 81,
  RC_OFF_TOTAL_REGISTERED = 113,
  RC_OFF_BUMP = 121;

// ── NullDomain account layout (mirrors the on-chain record) ───────────────────
// byte 0       : discriminator 0x4e ('N')
// bytes 65..97 : owner pubkey (32) — used for the My-Names memcmp filter
export const NULL_DOMAIN_DISC = 0x4e; // 'N'
export const ND_OFF_OWNER = 65;

// ── $NULL token decimals (for human-readable fee display) ─────────────────────
export const NULL_DECIMALS = 6;

// ── small byte helpers (Buffer-free so they work in the browser too) ──────────
function u8(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Pad a UTF-8 name into a fixed 64-byte buffer (zero-filled). Mirrors padName64.
 *  Backed by an explicit ArrayBuffer so it satisfies the BufferSource type that
 *  SubtleCrypto.digest expects under TS 5.7+ (Uint8Array<ArrayBuffer>). */
export function padName64(name: string): Uint8Array<ArrayBuffer> {
  const w = new TextEncoder().encode(name);
  if (w.length > 64) throw new Error(`name too long: ${name}`);
  const b = new Uint8Array(new ArrayBuffer(64));
  b.set(w, 0);
  return b;
}

/** sha256(padded 64-byte name) → 32-byte PDA seed. Matches the on-chain hash. */
export async function nameHash(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", padName64(name));
  return new Uint8Array(digest);
}

// ── PDA derivations ───────────────────────────────────────────────────────────
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [REGISTRY_SEED],
    REGISTRAR_PROGRAM,
  )[0];
}

export async function domainPda(name: string): Promise<PublicKey> {
  const h = await nameHash(name);
  return PublicKey.findProgramAddressSync(
    [DOMAIN_SEED, h],
    REGISTRAR_PROGRAM,
  )[0];
}

/** Canonical ATA of (owner, mint, tokenProgram). Mirrors ataOf in _lib.mjs:
 *  find_program_address([owner, token_program, mint], ATA_PROGRAM). */
export function ataOf(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_2022_PROGRAM,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

// ── Live config read/decode ───────────────────────────────────────────────────
export interface RegistryConfig {
  pda: PublicKey;
  owner: PublicKey;
  disc: number;
  authority: PublicKey;
  solFee: bigint;
  nullFee: bigint;
  nullMint: PublicKey;
  treasury: PublicKey;
  totalRegistered: bigint;
  bump: number;
}

function readU64LE(data: Uint8Array, off: number): bigint {
  // little-endian u64 → bigint, no Buffer dependency.
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

/** Read + decode the live RegistryConfig. Throws if missing / wrong disc / size. */
export async function readConfig(conn: Connection): Promise<RegistryConfig> {
  const pda = configPda();
  if (!pda.equals(CONFIG_PDA_EXPECTED)) {
    throw new Error(
      `config PDA mismatch: derived ${pda.toBase58()} != expected ${CONFIG_PDA_EXPECTED.toBase58()}`,
    );
  }
  const info = await conn.getAccountInfo(pda);
  if (!info) throw new Error(`config PDA ${pda.toBase58()} not found`);
  const d = info.data;
  if (d.length !== REGISTRY_CONFIG_SIZE) {
    throw new Error(
      `config is ${d.length} bytes, expected ${REGISTRY_CONFIG_SIZE} (v2)`,
    );
  }
  if (d[RC_OFF_DISC] !== REGISTRY_CONFIG_DISC) {
    throw new Error(
      `config disc 0x${d[RC_OFF_DISC].toString(16)} != 0x52`,
    );
  }
  return {
    pda,
    owner: info.owner,
    disc: d[RC_OFF_DISC],
    authority: new PublicKey(d.subarray(RC_OFF_AUTHORITY, RC_OFF_AUTHORITY + 32)),
    solFee: readU64LE(d, RC_OFF_SOL_FEE),
    nullFee: readU64LE(d, RC_OFF_NULL_FEE),
    nullMint: new PublicKey(d.subarray(RC_OFF_NULL_MINT, RC_OFF_NULL_MINT + 32)),
    treasury: new PublicKey(d.subarray(RC_OFF_TREASURY, RC_OFF_TREASURY + 32)),
    totalRegistered: readU64LE(d, RC_OFF_TOTAL_REGISTERED),
    bump: d[RC_OFF_BUMP],
  };
}

// ── Register instruction builders (PORTED verbatim from 06_verify.mjs) ─────────
// SOL Register data: [0x02][padName64(64)][zero(32)][CURRENCY_SOL(1)]
// Accounts: [payer(s,w), domain(w), config(w), system, treasury(w)]
export async function ixRegisterSol(
  payer: PublicKey,
  name: string,
  treasury: PublicKey,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_REGISTER),
    padName64(name),
    new Uint8Array(32), // unused 32-byte field (kept zero, matches _lib)
    u8(CURRENCY_SOL),
  );
  const domain = await domainPda(name);
  return new TransactionInstruction({
    programId: REGISTRAR_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: domain, isSigner: false, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}

// NULL Register data: [0x02][padName64(64)][zero(32)][CURRENCY_NULL(1)]
// Accounts: [payer(s,w), domain(w), config(w), system,
//            payer_null_ata(w), treasury_null_ata(w), token2022]
export async function ixRegisterNull(
  payer: PublicKey,
  name: string,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_REGISTER),
    padName64(name),
    new Uint8Array(32),
    u8(CURRENCY_NULL),
  );
  const domain = await domainPda(name);
  return new TransactionInstruction({
    programId: REGISTRAR_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: domain, isSigner: false, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ataOf(payer, NULL_MINT, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: ataOf(TREASURY, NULL_MINT, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// ── Name validation + tiers ───────────────────────────────────────────────────
export type NameTier = "registerable" | "premium" | "invalid";

export interface NameCheck {
  name: string;
  tier: NameTier;
  /** human-readable reason (always set; for "registerable" it's an empty string) */
  reason: string;
}

const NAME_RE = /^[a-z0-9-]+$/;

/** Normalize raw input the way the resolver does: lowercase, strip a trailing
 *  ".null", and drop any char outside [a-z0-9-]. */
export function normalizeName(raw: string): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/\.null$/, "")
    .replace(/[^a-z0-9-]/g, "");
}

/** Classify a (already-normalized) name into a tier with a reason. */
export function classifyName(name: string): NameCheck {
  if (name.length === 0) {
    return { name, tier: "invalid", reason: "Enter a name." };
  }
  if (!NAME_RE.test(name)) {
    return {
      name,
      tier: "invalid",
      reason: "Only lowercase letters, digits and hyphens are allowed.",
    };
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return {
      name,
      tier: "invalid",
      reason: "A name can't start or end with a hyphen.",
    };
  }
  if (name.length <= 3) {
    return {
      name,
      tier: "premium",
      reason: "1–3 character names are premium — auction-only. Auctions coming soon.",
    };
  }
  if (name.length > 32) {
    return {
      name,
      tier: "invalid",
      reason: "Names can be at most 32 characters.",
    };
  }
  return { name, tier: "registerable", reason: "" };
}

// ── Display helpers ───────────────────────────────────────────────────────────
export const lamportsToSol = (lamports: bigint | number): string =>
  (Number(lamports) / 1e9).toFixed(3).replace(/\.?0+$/, "");

/** $NULL atomic → human (6 decimals), rounded to a whole NULL for display. */
export const nullAtomicToHuman = (atomic: bigint | number): string => {
  const whole = Number(atomic) / 10 ** NULL_DECIMALS;
  return whole.toLocaleString("en-US", { maximumFractionDigits: 0 });
};

export const shortAddr = (s: string): string =>
  s.length > 16 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;

export const solscanTx = (sig: string): string =>
  `https://solscan.io/tx/${sig}`;

export const solscanAddr = (addr: string): string =>
  `https://solscan.io/account/${addr}`;
