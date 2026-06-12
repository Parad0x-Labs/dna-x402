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
import { poseidon2 } from "poseidon-lite";
import { configFor, type Cluster, type ClusterConfig } from "./cluster";

// ── Canonical mainnet ids (verified on-chain — DO NOT EDIT) ───────────────────
// NOTE: REGISTRAR_PROGRAM is the mainnet default used by the register/search/
// my-names flow. Cluster-aware callers (e.g. /pay on devnet) should derive the
// program + PDA via registrarFor(cluster) / domainPdaFor(cluster, name) below.
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
/** Canonical SPL Memo program (same id on devnet + mainnet). */
export const MEMO_PROGRAM = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

// ── Target fee (the on-chain target; read the LIVE value from config) ─────────
export const SOL_FEE_LAMPORTS = 7_000_000; // 0.007 SOL

// ── Instruction discriminants ─────────────────────────────────────────────────
export const IX_REGISTER = 0x02; // registrar Register
export const IX_CREATE_LISTING = 0x08; // auction CreateListing (resale buy-now ± auction)
export const IX_CREATE_PREMIUM_AUCTION = 0x07; // auction CreatePremiumAuction (SOL primary, 1–3 char)
export const IX_BUY_NOW = 0x09; // auction BuyNow (SOL-native)
export const CURRENCY_SOL = 1;
export const CURRENCY_NULL = 3;

// ── PDA seeds ─────────────────────────────────────────────────────────────────
export const REGISTRY_SEED = new TextEncoder().encode("null-registry");
export const DOMAIN_SEED = new TextEncoder().encode("null-domain");
export const AUCTION_SEED = new TextEncoder().encode("null-auction");

// ── AuctionState layout (mirrors programs/null-auction/src/state.rs EXACTLY) ───
// 325-byte v2 record; the first 308 bytes are identical to legacy v1.
// NOTE: buy_now_price @ 308 holds LAMPORTS since the SOL-native conversion
// (2026-06-10) — the field is reused; state.rs's "USD micro" doc predates it.
export const AUCTION_SIZE = 325;
export const AUCTION_SIZE_V1 = 308;
export const AS_DISC_RESALE = 0x41; // 'A' — 95/5 resale
export const AS_DISC_PRIMARY = 0x50; // 'P' — premium acquisition (100% treasury)
export const AS_OFF_SELLER = 1;
export const AS_OFF_DOMAIN = 33;
export const AS_OFF_TREASURY = 129;
export const AS_OFF_MIN_BID = 161; // u64 — min bid (LAMPORTS for SOL auctions)
export const AS_OFF_TOKEN_VAULT = 226; // [32] — all-zero ⇒ SOL auction (bids escrowed in the auction PDA)
export const AS_OFF_COMMIT_END = 274; // i64 — commit phase ends
export const AS_OFF_REVEAL_END = 282; // i64 — reveal phase ends (settle after)
export const AS_OFF_NUM_REVEALS = 298; // u64
export const AS_OFF_STATUS = 306; // 0=ACTIVE 1=SETTLED 2=CANCELLED
export const AS_OFF_BUY_NOW = 308; // u64 LAMPORTS (0 = auction-only)
export const AS_OFF_AUCTION_ENABLED = 316; // u8
export const AS_OFF_RESERVE = 317; // u64 — reserve (LAMPORTS for SOL auctions; 0 = none)
export const AS_STATUS_ACTIVE = 0;
export const AS_STATUS_SETTLED = 1;
export const AS_STATUS_CANCELLED = 2;

// auction (sealed-bid) instruction discriminants + commit PDA seed
export const IX_COMMIT_BID = 0x02;
export const IX_REVEAL_BID = 0x03;
export const IX_SETTLE_AUCTION = 0x04;
export const IX_CLAIM_REFUND = 0x06;
export const COMMIT_SEED = new TextEncoder().encode("commit");

// BN254 scalar field — the Poseidon commitment must reduce mod P (matches on-chain sol_poseidon).
export const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Upfront listing fee + settlement cut (mirror state.rs).
export const LISTING_FEE_LAMPORTS = 10_000_000n; // 0.01 SOL, charged at CreateListing
export const TREASURY_FEE_BPS = 500n; // 5% of the sale to treasury, 95% to seller

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

/** little-endian u64 (8 bytes) from a bigint|number — Buffer-free for the browser. */
function u64le(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
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

/** The registrar program for a cluster. */
export function registrarFor(c: Cluster | ClusterConfig): PublicKey {
  const cfg = typeof c === "string" ? configFor(c) : c;
  return new PublicKey(cfg.registrar);
}

/**
 * Cluster-aware domain PDA. mainnet seeds with sha256(padName64(name)); devnet
 * (the NullPay registrar) seeds with the RAW utf-8 name bytes. The kind comes
 * from the cluster config so /pay resolves the right account on devnet.
 */
export async function domainPdaFor(
  c: Cluster | ClusterConfig,
  name: string,
): Promise<PublicKey> {
  const cfg = typeof c === "string" ? configFor(c) : c;
  const program = new PublicKey(cfg.registrar);
  const seed =
    cfg.domainSeedKind === "raw"
      ? new TextEncoder().encode(name)
      : await nameHash(name);
  return PublicKey.findProgramAddressSync([DOMAIN_SEED, seed], program)[0];
}

// ── Marketplace (auction) PDAs + builders — SOL-native resale buy-now ──────────
//
// The auction program derives the domain PDA with sha256(padName64(name)) under
// its PAIRED registrar (cfg.auctionRegistrar), so these always use sha256 — never
// the cluster's raw-seed NullPay registrar. On mainnet auctionRegistrar===registrar.

export function auctionProgramFor(c: Cluster | ClusterConfig): PublicKey {
  const cfg = typeof c === "string" ? configFor(c) : c;
  return new PublicKey(cfg.auction);
}

export function auctionRegistrarFor(c: Cluster | ClusterConfig): PublicKey {
  const cfg = typeof c === "string" ? configFor(c) : c;
  return new PublicKey(cfg.auctionRegistrar);
}

/** Domain PDA AS THE AUCTION DERIVES IT: sha256 seed under the paired registrar. */
export async function auctionDomainPda(
  c: Cluster | ClusterConfig,
  name: string,
): Promise<PublicKey> {
  const h = await nameHash(name);
  return PublicKey.findProgramAddressSync([DOMAIN_SEED, h], auctionRegistrarFor(c))[0];
}

/** AuctionState PDA: seeds [b"null-auction", sha256(padName64(name))] under the auction. */
export async function auctionPda(
  c: Cluster | ClusterConfig,
  name: string,
): Promise<PublicKey> {
  const h = await nameHash(name);
  return PublicKey.findProgramAddressSync([AUCTION_SEED, h], auctionProgramFor(c))[0];
}

/**
 * CreateListing (0x08) — SOL-native fixed-price listing (auction_enabled=0, no vault).
 * Escrows the name to the auction PDA and charges the 0.01 SOL listing fee → treasury.
 *
 * payload: [0x08] name[64] buy_now(u64 LAMPORTS) reserve(u64) min_bid(u64) commit(u64)
 *          reveal(u64) bond(u64) sol_price(u64) null_price(u64) auction_enabled(u8)
 *          null_mint[32] usdc_mint[32] treasury[32]
 * accounts: [seller(s,w), domain(w), auction(w,init), treasury(w,sys), null_reg(ro), system(ro)]
 */
export async function ixCreateListingSol(
  c: Cluster | ClusterConfig,
  seller: PublicKey,
  name: string,
  buyNowLamports: bigint,
  treasury: PublicKey,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_CREATE_LISTING),
    padName64(name),
    u64le(buyNowLamports), // buy_now (lamports)
    u64le(0), // reserve
    u64le(0), // min_bid
    u64le(0), // commit_secs
    u64le(0), // reveal_secs
    u64le(0), // bond_lamports
    u64le(0), // sol_price_usd_micro
    u64le(0), // null_price_usd_micro
    u8(0), // auction_enabled = 0 → pure buy-now, no token vault
    new Uint8Array(32), // null_mint (unused for SOL buy-now)
    new Uint8Array(32), // usdc_mint (unused for SOL buy-now)
    treasury.toBytes(),
  );
  const domain = await auctionDomainPda(c, name);
  const auction = await auctionPda(c, name);
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: domain, isSigner: false, isWritable: true },
      { pubkey: auction, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * BuyNow (0x09) — SOL. Pays state.buy_now_price: 95% seller / 5% treasury; name → buyer.
 * accounts: [buyer(s,w), auction(w), domain(w), seller(w,sys), treasury(w,sys), null_reg(ro), system(ro)]
 */
export async function ixBuyNowSol(
  c: Cluster | ClusterConfig,
  buyer: PublicKey,
  seller: PublicKey,
  name: string,
  treasury: PublicKey,
): Promise<TransactionInstruction> {
  const domain = await auctionDomainPda(c, name);
  const auction = await auctionPda(c, name);
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: auction, isSigner: false, isWritable: true },
      { pubkey: domain, isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_BUY_NOW), padName64(name))),
  });
}

// ── SOL SEALED-BID AUCTION (commit → reveal → settle) ─────────────────────────
// Proven on devnet: a listing with auction_enabled=1 AND a zero usdc_mint is a SOL
// auction — bids are plain SOL escrowed in the auction PDA (no token vault).

/** BidCommitment PDA: seeds [b"commit", auctionPda, bidder]. */
export async function commitPda(
  c: Cluster | ClusterConfig,
  name: string,
  bidder: PublicKey,
): Promise<PublicKey> {
  const a = await auctionPda(c, name);
  return PublicKey.findProgramAddressSync([COMMIT_SEED, a.toBuffer(), bidder.toBuffer()], auctionProgramFor(c))[0];
}

/** Poseidon2(bid_lamports, blinding) → 32-byte BE commitment (matches on-chain sol_poseidon). */
export function poseidonCommit(bidLamports: bigint, blinding: Uint8Array): Uint8Array {
  let b = 0n;
  for (const byte of blinding) b = (b << 8n) | BigInt(byte);
  const h = poseidon2([bidLamports, b % BN254_P]);
  const out = new Uint8Array(32);
  let v = h;
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** Fresh 31-byte blinding (< BN254 field). The bidder MUST keep this to reveal later. */
export function freshBlinding(): Uint8Array {
  const b = new Uint8Array(31);
  crypto.getRandomValues(b);
  return b;
}

/**
 * CreateListing (0x08) as a SOL SEALED-BID AUCTION: auction_enabled=1, usdc_mint=ZERO.
 * Escrows the name + charges the 0.01 SOL fee. min_bid / reserve are in LAMPORTS.
 * accounts: [seller(s,w), domain(w), auction(w), treasury(w,sys), null_reg(ro), system(ro)]
 */
export async function ixCreateSolAuction(
  c: Cluster | ClusterConfig,
  seller: PublicKey,
  name: string,
  minBidLamports: bigint,
  reserveLamports: bigint,
  commitSecs: number,
  revealSecs: number,
  treasury: PublicKey,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_CREATE_LISTING),
    padName64(name),
    u64le(0), // buy_now = 0 (auction-only)
    u64le(reserveLamports),
    u64le(minBidLamports),
    u64le(commitSecs),
    u64le(revealSecs),
    u64le(0), // bond
    u64le(1), // sol_price (dummy nonzero; unused for SOL bids)
    u64le(1), // null_price (dummy nonzero)
    u8(1), // auction_enabled = 1
    new Uint8Array(32), // null_mint
    new Uint8Array(32), // usdc_mint = ZERO ⇒ SOL auction (no vault)
    treasury.toBytes(),
  );
  const domain = await auctionDomainPda(c, name);
  const auction = await auctionPda(c, name);
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: domain, isSigner: false, isWritable: true },
      { pubkey: auction, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** CommitBid (0x02): [bidder(s,w), auction(w), commit(w), system]. commitment = poseidonCommit(...). */
export async function ixCommitBid(
  c: Cluster | ClusterConfig,
  bidder: PublicKey,
  name: string,
  commitment: Uint8Array,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await commitPda(c, name, bidder), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_COMMIT_BID), padName64(name), commitment)),
  });
}

/** RevealBid (0x03) SOL: [bidder(s,w), auction(w), commit(w), system]. Escrows the SOL bid. */
export async function ixRevealBidSol(
  c: Cluster | ClusterConfig,
  bidder: PublicKey,
  name: string,
  bidLamports: bigint,
  blinding: Uint8Array, // 31 bytes
): Promise<TransactionInstruction> {
  const blind32 = new Uint8Array(32);
  blind32.set(blinding, 1); // leading zero byte + 31-byte blinding
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await commitPda(c, name, bidder), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_REVEAL_BID), padName64(name), u64le(bidLamports), u8(CURRENCY_SOL), blind32)),
  });
}

/**
 * SettleAuction (0x04) SOL resale: [payer(s,w), auction(w), domain(w), seller(w), treasury(w),
 *   dummyVault(ro), null_reg(ro), dummyTokenProg(ro)]. Anyone may crank it after the reveal phase.
 */
export async function ixSettleSol(
  c: Cluster | ClusterConfig,
  payer: PublicKey,
  name: string,
  sellerWallet: PublicKey,
  treasuryWallet: PublicKey,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: sellerWallet, isSigner: false, isWritable: true },
      { pubkey: treasuryWallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // dummy token_vault
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // dummy token_prog
    ],
    data: Buffer.from(concatBytes(u8(IX_SETTLE_AUCTION), padName64(name))),
  });
}

/** ClaimBondRefund (0x06) SOL: [bidder(s,w), auction(W), commit(w)]. A loser reclaims their bid. */
export async function ixClaimRefundSol(
  c: Cluster | ClusterConfig,
  bidder: PublicKey,
  name: string,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await commitPda(c, name, bidder), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concatBytes(u8(IX_CLAIM_REFUND), padName64(name))),
  });
}

/**
 * Per-length SOL floor (lamports) a premium primary auction's opening bid must meet.
 * Mirrors programs/null-auction premium_floor_lamports: the default (mainnet) build
 * enforces 33 / 10 / 3 SOL for 1 / 2 / 3-char; the devnet build uses 0.3 / 0.2 / 0.1
 * so the lifecycle is cheap to exercise. The chain is the source of truth — a
 * below-floor opening bid simply reverts (OpeningBidBelowFloor 0x801D).
 */
export function premiumFloorLamports(charLen: number, c: Cluster | ClusterConfig): bigint {
  const cluster = typeof c === "string" ? c : c.cluster;
  if (cluster === "devnet") return charLen === 1 ? 300_000_000n : charLen === 2 ? 200_000_000n : 100_000_000n;
  return charLen === 1 ? 33_000_000_000n : charLen === 2 ? 10_000_000_000n : 3_000_000_000n;
}
export const premiumFloorSol = (charLen: number, c: Cluster | ClusterConfig): number =>
  Number(premiumFloorLamports(charLen, c)) / 1e9;

/**
 * CreatePremiumAuction (0x07) SOL — open a PRIMARY auction on an UNOWNED 1–3 char name,
 * locking the opening bid in SOL (the creator becomes the pre-revealed standing high bid).
 * accounts: [creator(s,w), domain(ro), auction(w), commit(w), null_reg(ro), system(ro)]
 * payload:  name[64] | opening_bid_lamports(u64) | commit_secs(u64) | reveal_secs(u64) | treasury[32]
 */
export async function ixCreatePremiumAuctionSol(
  c: Cluster | ClusterConfig,
  creator: PublicKey,
  name: string,
  openingBidLamports: bigint,
  commitSecs: number,
  revealSecs: number,
  treasury: PublicKey,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_CREATE_PREMIUM_AUCTION),
    padName64(name),
    u64le(openingBidLamports),
    u64le(commitSecs),
    u64le(revealSecs),
    treasury.toBytes(),
  );
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: false },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await commitPda(c, name, creator), isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * SettleAuction (0x04) PRIMARY/premium — mints the name to the winner (CPI MintPremium)
 * and pays 100% of the winning bid → the treasury WALLET in SOL. Differs from the resale
 * settle by appending the registrar config PDA + system program (mint CPI). The seller /
 * vault / token-program slots are unused for a SOL primary (treasury wallet placeholders).
 * accounts: [payer(s,w), auction(w), domain(w), seller(w·unused), treasury(w),
 *   vault(w·unused), null_reg(ro), token_prog(ro·unused), registrar_config(w), system(ro)]
 */
export async function ixSettlePremiumSol(
  c: Cluster | ClusterConfig,
  payer: PublicKey,
  name: string,
  treasuryWallet: PublicKey,
): Promise<TransactionInstruction> {
  const reg = auctionRegistrarFor(c);
  const registrarConfig = PublicKey.findProgramAddressSync([REGISTRY_SEED], reg)[0];
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: await auctionPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: treasuryWallet, isSigner: false, isWritable: true }, // seller slot (unused)
      { pubkey: treasuryWallet, isSigner: false, isWritable: true }, // treasury wallet (100% SOL)
      { pubkey: treasuryWallet, isSigner: false, isWritable: true }, // vault slot (unused for SOL)
      { pubkey: reg, isSigner: false, isWritable: false },
      { pubkey: reg, isSigner: false, isWritable: false }, // token_prog slot (unused)
      { pubkey: registrarConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_SETTLE_AUCTION), padName64(name))),
  });
}

// ── Make-offer (0x0A MakeOffer / 0x0B AcceptOffer / 0x0C CancelOffer) ──────────
// A buyer escrows a standing SOL offer on any REGISTERED name; the owner accepts
// (95% owner / 5% treasury, name → buyer) or the buyer cancels (full refund). No
// timers, no reveal. OfferRecord (74B, disc 'O') PDA = [b"offer", name_hash, buyer].
export const IX_MAKE_OFFER = 0x0a;
export const IX_ACCEPT_OFFER = 0x0b;
export const IX_CANCEL_OFFER = 0x0c;
export const IX_INIT_CONFIG = 0x0d; // auction InitConfig (fee-governance singleton)
export const IX_SET_FEE = 0x0e; // auction SetFee (capped 5%, decrease instant / increase +48h)
export const IX_CREATE_ENGLISH = 0x0f; // open ascending ("English") SOL auction
export const IX_PLACE_BID = 0x10; // English open ascending bid
export const IX_SETTLE_ENGLISH = 0x11; // English settle (winner / no-bids return)
export const IX_CANCEL_ENGLISH = 0x12; // English cancel (no-bid only)
export const OFFER_SEED = new TextEncoder().encode("offer");
export const ENGLISH_SEED = new TextEncoder().encode("eng-auction");
export const CONFIG_SEED = new TextEncoder().encode("auction-config");
export const OFFER_DISC = 0x4f; // 'O'
export const OFFER_SIZE = 74;
export const OF_OFF_BUYER = 1; // [32]
export const OF_OFF_DOMAIN = 33; // [32]
export const OF_OFF_AMOUNT = 65; // u64 lamports
/** Hardcoded protocol treasury (the 5% cut). Must match PROTOCOL_TREASURY in the program. */
export const PROTOCOL_TREASURY = new PublicKey("F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY");

/** OfferRecord PDA for (name, buyer). */
export async function offerPda(c: Cluster | ClusterConfig, name: string, buyer: PublicKey): Promise<PublicKey> {
  const h = await nameHash(name);
  return PublicKey.findProgramAddressSync([OFFER_SEED, h, buyer.toBuffer()], auctionProgramFor(c))[0];
}

/** MakeOffer (0x0A): [buyer(s,w), domain(ro), offer(w), null_reg(ro), system]. */
export async function ixMakeOfferSol(c: Cluster | ClusterConfig, buyer: PublicKey, name: string, amountLamports: bigint): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: false },
      { pubkey: await offerPda(c, name, buyer), isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_MAKE_OFFER), padName64(name), u64le(amountLamports))),
  });
}

/** AcceptOffer (0x0B): [owner(s,w), domain(w), offer(w), buyer(ro), treasury(w), null_reg(ro)]. */
export async function ixAcceptOfferSol(c: Cluster | ClusterConfig, owner: PublicKey, name: string, buyer: PublicKey): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await offerPda(c, name, buyer), isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: PROTOCOL_TREASURY, isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_ACCEPT_OFFER), padName64(name))),
  });
}

/** CancelOffer (0x0C): [buyer(s,w), offer(w)]. */
export async function ixCancelOfferSol(c: Cluster | ClusterConfig, buyer: PublicKey, name: string): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: await offerPda(c, name, buyer), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concatBytes(u8(IX_CANCEL_OFFER), padName64(name))),
  });
}

// ── English (open ascending) auction ──────────────────────────────────────────
// EnglishAuction account (171B): disc 'E'(0x45)@0 | seller[32]@1 | domain[32]@33 |
// treasury[32]@65 | start_price(u64)@97 | end_ts(i64)@105 | highest_bid(u64)@113 |
// highest_bidder[32]@121 | num_bids(u64)@153 | status@161 | bump@162.
export const ENGLISH_DISC = 0x45; // 'E'
export const ENGLISH_SIZE = 171;
export const EN_OFF_SELLER = 1, EN_OFF_DOMAIN = 33, EN_OFF_TREASURY = 65, EN_OFF_START = 97,
  EN_OFF_END = 105, EN_OFF_HIGH = 113, EN_OFF_HIGHBIDDER = 121, EN_OFF_NUM = 153, EN_OFF_STATUS = 161;
/** +5% min step over the high, floor 0.05 SOL — mirrors ENGLISH_MIN_STEP_* in the program. */
export const ENGLISH_MIN_STEP_BPS = 500n, ENGLISH_MIN_STEP_FLOOR = 50_000_000n;
/** Minimum acceptable next bid (lamports) given the current high (0 = first bid → start). */
export function englishMinNextBid(highLamports: bigint, startLamports: bigint): bigint {
  if (highLamports === 0n) return startLamports;
  const step = (highLamports * ENGLISH_MIN_STEP_BPS) / 10_000n;
  return highLamports + (step > ENGLISH_MIN_STEP_FLOOR ? step : ENGLISH_MIN_STEP_FLOOR);
}

/** EnglishAuction PDA: seeds [b"eng-auction", nameHash]. */
export async function englishPda(c: Cluster | ClusterConfig, name: string): Promise<PublicKey> {
  const h = await nameHash(name);
  return PublicKey.findProgramAddressSync([ENGLISH_SEED, h], auctionProgramFor(c))[0];
}
/** AuctionConfig PDA (fee-governance singleton): seeds [b"auction-config"]. */
export function auctionConfigPda(c: Cluster | ClusterConfig): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], auctionProgramFor(c))[0];
}

/** CreateEnglishAuction (0x0F): [seller(s,w), english(w), domain(w), null_reg(ro), system]. */
export async function ixCreateEnglishAuction(c: Cluster | ClusterConfig, seller: PublicKey, name: string, startPriceLamports: bigint, durationSecs: bigint): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: await englishPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_CREATE_ENGLISH), padName64(name), u64le(startPriceLamports), u64le(durationSecs), PROTOCOL_TREASURY.toBuffer())),
  });
}

/** PlaceBid (0x10): [bidder(s,w), english(w), prev_leader(w), system]. prevLeader = the current
 *  highest_bidder (refunded here); on the FIRST bid pass any placeholder (e.g. the bidder). */
export async function ixPlaceBidEnglish(c: Cluster | ClusterConfig, bidder: PublicKey, name: string, amountLamports: bigint, prevLeader: PublicKey): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: await englishPda(c, name), isSigner: false, isWritable: true },
      { pubkey: prevLeader, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_PLACE_BID), padName64(name), u64le(amountLamports))),
  });
}

/** SettleEnglish (0x11): [cranker(s,w), english(w), domain(w), null_reg(ro), seller(w), treasury(w), config(ro)]. */
export async function ixSettleEnglish(c: Cluster | ClusterConfig, cranker: PublicKey, name: string, seller: PublicKey): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: await englishPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
      { pubkey: seller, isSigner: false, isWritable: true },
      { pubkey: PROTOCOL_TREASURY, isSigner: false, isWritable: true },
      { pubkey: auctionConfigPda(c), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_SETTLE_ENGLISH), padName64(name))),
  });
}

/** CancelEnglish (0x12) — seller cancels a NO-BID auction: [seller(s,w), english(w), domain(w), null_reg(ro)]. */
export async function ixCancelEnglish(c: Cluster | ClusterConfig, seller: PublicKey, name: string): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionProgramFor(c),
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: await englishPda(c, name), isSigner: false, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: auctionRegistrarFor(c), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_CANCEL_ENGLISH), padName64(name))),
  });
}

// ── NullPay stealth-meta layout (sha256-seed registrar v2 NullDomain) ─────────
// The recipient's 64-byte ed25519 meta-address (spend_pub || view_pub) lives at
// offset 314 — immediately ABOVE the 314-byte base — and a stealth-enabled account
// is 378 bytes. Written by SetStealthMeta (0x0c), which reallocs 314 -> 378.
// This is the SAME layout on mainnet (H4wbFJ) and the devnet v2 registrar; it is
// NOT the old raw-seed NullPay build (which used offset 154).
export const ND_OFF_STEALTH_META = 314;
export const ND_STEALTH_META_LEN = 64;
export const ND_V2_MIN_LEN = 378;

// Registrar opcode (distinct program from the auction's 0x0c CancelOffer).
export const IX_SET_STEALTH_META = 0x0c;

/**
 * SetStealthMeta (0x0c) — publish the recipient's 64-byte ed25519 stealth meta on
 * the cluster's sha256-seed registrar (mainnet H4wbFJ; devnet the v2 registrar —
 * i.e. cfg.auctionRegistrar, which is sha256 on both clusters). Owner-only; the
 * first call reallocs the domain 314 -> 378 with an owner-paid rent top-up.
 * accounts: [owner (signer, writable / rent payer), domain (writable), system].
 */
export async function ixSetStealthMeta(
  c: Cluster | ClusterConfig,
  owner: PublicKey,
  name: string,
  meta64: Uint8Array,
): Promise<TransactionInstruction> {
  if (meta64.length !== ND_STEALTH_META_LEN) throw new Error("stealth meta must be 64 bytes");
  return new TransactionInstruction({
    programId: auctionRegistrarFor(c),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(IX_SET_STEALTH_META), padName64(name), meta64)),
  });
}

// ── classic SPL Token (USDC) + stealth pay-tx helpers ─────────────────────────

/** Classic SPL Token program (USDC etc.) — NOT Token-2022. */
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const USDC_DECIMALS = 6;

/** Circle USDC mint per cluster (mainnet vs devnet test USDC). */
export function usdcMintFor(c: Cluster | ClusterConfig): PublicKey {
  const cl = typeof c === "string" ? c : c.cluster;
  return cl === "mainnet"
    ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    : new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet USDC
}

/** Resolve (0x05) — read-only registrar call that touches the domain PDA. Bundled
 *  into a private payment so the recipient can FIND it via getSignaturesForAddress
 *  on their domain PDA (a bare memo isn't address-queryable). */
export async function ixResolve(
  c: Cluster | ClusterConfig,
  name: string,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: auctionRegistrarFor(c),
    keys: [{ pubkey: await auctionDomainPda(c, name), isSigner: false, isWritable: false }],
    data: Buffer.from(concatBytes(u8(0x05), padName64(name))),
  });
}

/** ATA-program CreateIdempotent (data=[1]) — make owner's ATA for mint if absent. */
export function ixCreateAtaIdempotent(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM,
): { ata: PublicKey; ix: TransactionInstruction } {
  const ata = ataOf(owner, mint, tokenProgram);
  const ix = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  return { ata, ix };
}

/** SPL Token Transfer (opcode 3): source -> dest, signed by authority, amount atomic. */
export function ixSplTransfer(
  source: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  amount: bigint,
  tokenProgram: PublicKey = TOKEN_PROGRAM,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(concatBytes(u8(3), u64le(amount))),
  });
}

/** SPL Token CloseAccount (opcode 9): close `account`, rent -> dest, signed by authority. */
export function ixCloseAccount(
  account: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

/** A bare SPL-Memo instruction carrying `text`. */
export function ixMemo(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, "utf8") });
}

// ── NullPay announce string (sender publishes; recipient scans) ───────────────
export const STEALTH_ANNOUNCE_PREFIX = "nullpay:v1:";
/** `nullpay:v1:<name>.null:R=<ephemHex>` */
export function buildAnnounce(name: string, ephemHex: string): string {
  return `${STEALTH_ANNOUNCE_PREFIX}${name}.null:R=${ephemHex}`;
}
/** Parse a memo -> { name, ephemHex } or null. */
export function parseAnnounce(memo: string): { name: string; ephemHex: string } | null {
  if (!memo.startsWith(STEALTH_ANNOUNCE_PREFIX)) return null;
  const m = memo.match(/^nullpay:v1:(.+)\.null:R=([0-9a-fA-F]{64})$/);
  return m ? { name: m[1], ephemHex: m[2] } : null;
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
// ── 3/wallet anti-squat cap (Register only — premium-auction winners are exempt) ──
// The registrar's OwnerCapacity PDA [b"owner-cap", owner] counts a wallet's PROTOCOL
// (free Register) acquisitions; the cap (3) is enforced on Register, NOT on premium mints.
export const OWNER_CAP_SEED = new TextEncoder().encode("owner-cap");
export function ownerCapPda(owner: PublicKey, program: PublicKey = REGISTRAR_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync([OWNER_CAP_SEED, owner.toBuffer()], program)[0];
}

// SOL Register. The registrar reads the treasury fee account ONLY when sol_fee > 0, then
// owner_cap as the LAST account. So in the FREE pilot (fee==0) owner_cap sits at index 4
// (no treasury); with a fee it sits at index 5 (after treasury). The pre-cap registrar
// ignores the trailing owner_cap, so this is safe to ship before the cap registrar lands.
export async function ixRegisterSol(
  payer: PublicKey,
  name: string,
  treasury: PublicKey,
  feeLamports: bigint = 0n,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_REGISTER),
    padName64(name),
    new Uint8Array(32), // unused 32-byte field (kept zero, matches _lib)
    u8(CURRENCY_SOL),
  );
  const domain = await domainPda(name);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: domain, isSigner: false, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (feeLamports > 0n) keys.push({ pubkey: treasury, isSigner: false, isWritable: true });
  keys.push({ pubkey: ownerCapPda(payer), isSigner: false, isWritable: true }); // cap account — ALWAYS last
  return new TransactionInstruction({ programId: REGISTRAR_PROGRAM, keys, data: Buffer.from(data) });
}

// NULL Register. Fee accounts (payer_ata, treasury_ata, token2022) only when null_fee > 0,
// then owner_cap LAST. Free pilot → owner_cap at index 4.
export async function ixRegisterNull(
  payer: PublicKey,
  name: string,
  feeAmount: bigint = 0n,
): Promise<TransactionInstruction> {
  const data = concatBytes(
    u8(IX_REGISTER),
    padName64(name),
    new Uint8Array(32),
    u8(CURRENCY_NULL),
  );
  const domain = await domainPda(name);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: domain, isSigner: false, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (feeAmount > 0n) {
    keys.push({ pubkey: ataOf(payer, NULL_MINT, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true });
    keys.push({ pubkey: ataOf(TREASURY, NULL_MINT, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true });
    keys.push({ pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false });
  }
  keys.push({ pubkey: ownerCapPda(payer), isSigner: false, isWritable: true }); // cap account — ALWAYS last
  return new TransactionInstruction({ programId: REGISTRAR_PROGRAM, keys, data: Buffer.from(data) });
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
      reason: `${name.length}-character names are premium — claimed by opening a sealed-bid SOL auction.`,
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
