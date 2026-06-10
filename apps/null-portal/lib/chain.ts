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
  ND_OFF_STEALTH_META,
  ND_STEALTH_META_LEN,
  domainPda,
  domainPdaFor,
  ataOf,
  AS_DISC_RESALE,
  AS_DISC_PRIMARY,
  AS_OFF_SELLER,
  AS_OFF_DOMAIN,
  AS_OFF_TREASURY,
  AS_OFF_MIN_BID,
  AS_OFF_COMMIT_END,
  AS_OFF_REVEAL_END,
  AS_OFF_NUM_REVEALS,
  AS_OFF_STATUS,
  AS_OFF_BUY_NOW,
  AS_OFF_AUCTION_ENABLED,
  AS_STATUS_ACTIVE,
  AUCTION_SIZE,
  AUCTION_SIZE_V1,
  OFFER_DISC,
  OFFER_SIZE,
  OF_OFF_BUYER,
  OF_OFF_DOMAIN,
  OF_OFF_AMOUNT,
} from "./null-sdk";
import { CLUSTERS, configFor, type Cluster } from "./cluster";

/** little-endian u64 → bigint (Buffer-free). */
function readU64LE(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}
/** little-endian i64 → number (unix-second timestamps fit a JS number). */
function readI64LE(data: Uint8Array, off: number): number {
  return Number(BigInt.asIntN(64, readU64LE(data, off)));
}

// Default to a fast KEYLESS public RPC — api.mainnet-beta.solana.com is slow +
// heavily rate-limited (429s). publicnode needs no signup. For production, set
// NEXT_PUBLIC_RPC_URL to a Helius/Triton/QuickNode endpoint for max speed.
export const DEFAULT_RPC = CLUSTERS.mainnet.rpc;

// One Connection per cluster RPC (keeps its keep-alive fetch agent) instead of
// building a fresh one on every keystroke.
const _conns = new Map<string, Connection>();
function connFor(rpc: string): Connection {
  let c = _conns.get(rpc);
  if (!c) {
    c = new Connection(rpc, "confirmed");
    _conns.set(rpc, c);
  }
  return c;
}

/** The mainnet connection — the register/search/my-names default. */
export function getConnection(): Connection {
  return connFor(DEFAULT_RPC);
}

// ── Resilient getProgramAccounts ──────────────────────────────────────────────
// gPA is a heavy, unindexed program scan. The keyless default (publicnode) is fast
// for single-account reads but CANNOT serve gPA at all — it 504 Gateway-Times-out
// after ~90s even WITH a dataSize filter (measured). So for program scans we:
//   1. prefer a gPA-capable endpoint (a dedicated RPC if NEXT_PUBLIC_RPC_URL_* is set,
//      else api.mainnet-beta), and keep publicnode only as a last resort;
//   2. cap each attempt with a CLIENT timeout so a hung endpoint can't stall the UI;
//   3. fall back across endpoints, surfacing an error only if every one fails.
// Single-account reads (getAccountInfo / availability) keep using the fast default RPC.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GPA_TIMEOUT_MS = 11_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("client timeout")), ms))]);
}
// "this endpoint can't serve the scan → try the next one". Covers transient failures
// (429/5xx/timeout/network) AND hard refusals (403 Access-forbidden / CORS / "method not
// available on free tier") — every keyless public mainnet RPC refuses browser gPA one way
// or another, so we sweep the list and only surface an error once ALL endpoints fail.
function isEndpointUnusable(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e).toLowerCase();
  return /failed to fetch|fetch failed|429|too many|timeout|time-?out|gateway|40[13]|50[234]|forbidden|not available|free ?tier|not enabled|disabled|network|socket|econn|aborted/.test(m);
}
const ENV_MAIN_RPC = process.env.NEXT_PUBLIC_RPC_URL_MAINNET || process.env.NEXT_PUBLIC_RPC_URL;
const ENV_DEV_RPC = process.env.NEXT_PUBLIC_RPC_URL_DEVNET;
// gPA-capable endpoints in preference order. publicnode is OMITTED on purpose — it 504s
// on every gPA. On MAINNET no keyless RPC serves browser program-scans, so a dedicated
// NEXT_PUBLIC_RPC_URL_MAINNET (Helius/Triton/QuickNode) is required for the marketplace +
// My-Names; devnet's api.devnet.solana.com does allow browser gPA.
const RPC_FALLBACKS: Record<Cluster, string[]> = {
  mainnet: Array.from(new Set([ENV_MAIN_RPC, "https://api.mainnet-beta.solana.com"].filter(Boolean) as string[])),
  devnet: Array.from(new Set([ENV_DEV_RPC, "https://api.devnet.solana.com"].filter(Boolean) as string[])),
};
type GpaConfig = Parameters<Connection["getProgramAccounts"]>[1];
type GpaResult = Awaited<ReturnType<Connection["getProgramAccounts"]>>;
export class RpcScanUnavailable extends Error {
  constructor(public cluster: Cluster, public lastDetail: string) {
    super(
      cluster === "mainnet"
        ? `Mainnet program reads need a dedicated RPC. Public nodes block getProgramAccounts from browsers (last: ${lastDetail}). Set NEXT_PUBLIC_RPC_URL_MAINNET to a Helius/Triton/QuickNode endpoint (free tier).`
        : `Couldn't reach an RPC for this scan (last: ${lastDetail}). Retry, or set NEXT_PUBLIC_RPC_URL_DEVNET.`,
    );
    this.name = "RpcScanUnavailable";
  }
}
async function gpaResilient(cluster: Cluster, programId: PublicKey, config: GpaConfig): Promise<GpaResult> {
  const rpcs = RPC_FALLBACKS[cluster];
  let lastErr: unknown;
  for (const rpc of rpcs) {
    try {
      return await withTimeout(connFor(rpc).getProgramAccounts(programId, config), GPA_TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
      if (!isEndpointUnusable(e)) throw e; // a genuine programming error — don't sweep
      await sleep(150);
    }
  }
  throw new RpcScanUnavailable(cluster, ((lastErr as { message?: string })?.message ?? "unknown").slice(0, 80));
}

/** Cluster-aware connection (mainnet | devnet). Used by /pay on devnet. */
export function getConnectionForCluster(cluster: Cluster): Connection {
  return connFor(CLUSTERS[cluster].rpc);
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
  cluster: Cluster,
  owner: PublicKey,
  registrar: PublicKey = REGISTRAR_PROGRAM,
): Promise<OwnedName[]> {
  const accounts = await gpaResilient(cluster, registrar, {
    // memcmp on the owner field @ offset 65 == the connected wallet, applied SERVER-side
    // so the RPC returns ONLY this wallet's domains (a few accounts, milliseconds). The
    // disc ('N' @ byte 0) is re-checked client-side below. gpaResilient prefers a
    // gPA-capable endpoint + caps the call, so a slow node can't hang or crash the page.
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

// ── Marketplace listings (cluster-aware, real decoder) ────────────────────────
//
// readMarketplaceListings does a REAL, read-only getProgramAccounts over the
// auction program, decodes each live AuctionState (state.rs layout), keeps the
// ACTIVE ones that carry a buy-now price, then batch-reads the escrowed domain
// accounts to recover each plaintext .null name. No fabrication: a name/price/
// seller only appears if it is on-chain right now. `wired: true` once decoded.

export interface MarketListing {
  /** the .null name being sold, e.g. "vault" */
  name: string;
  /** AuctionState account pubkey (base58) */
  pda: string;
  /** seller wallet (base58) — receives 95% on sale */
  seller: string;
  /** treasury wallet (base58) recorded in the listing — needed to build BuyNow */
  treasury: string;
  /** "buy-now" fixed price or "auction" */
  kind: "buy-now" | "auction" | "premium";
  /** buy-now price in LAMPORTS (0 = auction-only listing) */
  lamports: bigint;
  /** auctions only: min bid (LAMPORTS), commit/reveal phase ends (unix secs), reveal count */
  minBid: bigint;
  commitEnd: number;
  revealEnd: number;
  numReveals: bigint;
}

export interface MarketSnapshot {
  /** whether a real listing decoder is wired for this cluster */
  wired: boolean;
  /** the auction/marketplace program probed (base58) */
  program: string;
  /** count of accounts owned by that program right now (truthful, live) */
  programAccounts: number | null;
  /** decoded listings — empty until a listing layout is wired in */
  listings: MarketListing[];
  /** set when the program scan couldn't run (RPC blocked gPA) — UI shows this, not
   *  a misleading "no listings". null/undefined means the scan ran fine. */
  rpcError?: string;
}

/**
 * Read the live marketplace state for a cluster. Real RPC, no fabrication: decodes
 * every ACTIVE AuctionState that carries a buy-now price and resolves its name.
 */
export async function readMarketplaceListings(
  cluster: Cluster,
): Promise<MarketSnapshot> {
  const cfg = configFor(cluster);
  const program = new PublicKey(cfg.auction);
  const conn = connFor(cfg.rpc); // for the (cheap, single-batch) domain-name lookups below

  let raw: { pubkey: PublicKey; account: { data: Uint8Array } }[];
  try {
    // Only AuctionState records (325B): a server-side dataSize filter skips the commit
    // (116B) + vault (165B) accounts, so the response is just the live listings and
    // comes back in milliseconds on a gPA-capable endpoint (publicnode can't do gPA).
    raw = (await gpaResilient(cluster, program, { filters: [{ dataSize: AUCTION_SIZE }] })) as unknown as typeof raw;
  } catch (e) {
    // Every endpoint failed/rejected the scan — surface a clear rpcError so the UI shows
    // "couldn't reach the marketplace RPC" instead of a misleading "no listings".
    const rpcError = e instanceof Error ? e.message : String(e);
    return { wired: true, program: program.toBase58(), programAccounts: null, listings: [], rpcError };
  }
  const programAccounts = raw.length;

  // Decode each AuctionState; keep ACTIVE listings that are either buy-now (price > 0)
  // or a sealed-bid auction (auction_enabled == 1).
  type Partial = {
    pda: string; seller: string; treasury: string; domain: PublicKey;
    lamports: bigint; kind: MarketListing["kind"];
    minBid: bigint; commitEnd: number; revealEnd: number; numReveals: bigint;
  };
  const partials: Partial[] = [];
  for (const { pubkey, account } of raw) {
    const d = account.data;
    if (d.length < AUCTION_SIZE_V1) continue;
    const disc = d[0];
    if (disc !== AS_DISC_RESALE && disc !== AS_DISC_PRIMARY) continue;
    if (d[AS_OFF_STATUS] !== AS_STATUS_ACTIVE) continue;
    const lamports = d.length > AS_OFF_BUY_NOW ? readU64LE(d, AS_OFF_BUY_NOW) : 0n;
    const auctionEnabled = d.length > AS_OFF_AUCTION_ENABLED ? d[AS_OFF_AUCTION_ENABLED] : 1;
    if (lamports === 0n && !auctionEnabled) continue; // nothing to sell
    partials.push({
      pda: pubkey.toBase58(),
      seller: new PublicKey(d.subarray(AS_OFF_SELLER, AS_OFF_SELLER + 32)).toBase58(),
      treasury: new PublicKey(d.subarray(AS_OFF_TREASURY, AS_OFF_TREASURY + 32)).toBase58(),
      domain: new PublicKey(d.subarray(AS_OFF_DOMAIN, AS_OFF_DOMAIN + 32)),
      lamports,
      kind: disc === AS_DISC_PRIMARY ? "premium" : auctionEnabled ? "auction" : "buy-now",
      minBid: readU64LE(d, AS_OFF_MIN_BID),
      commitEnd: auctionEnabled ? readI64LE(d, AS_OFF_COMMIT_END) : 0,
      revealEnd: auctionEnabled ? readI64LE(d, AS_OFF_REVEAL_END) : 0,
      numReveals: readU64LE(d, AS_OFF_NUM_REVEALS),
    });
  }

  // Batch-read the escrowed domain accounts to recover plaintext names.
  const names = new Map<string, string>();
  for (let i = 0; i < partials.length; i += 100) {
    const slice = partials.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(slice.map((p) => p.domain));
    infos.forEach((info, j) => {
      if (info && info.data.length > 0 && info.data[0] === NULL_DOMAIN_DISC) {
        names.set(slice[j].domain.toBase58(), decodeName(info.data));
      }
    });
  }

  const listings: MarketListing[] = partials
    .map((p) => ({
      name: names.get(p.domain.toBase58()) ?? "", pda: p.pda, seller: p.seller, treasury: p.treasury,
      kind: p.kind, lamports: p.lamports, minBid: p.minBid, commitEnd: p.commitEnd, revealEnd: p.revealEnd, numReveals: p.numReveals,
    }))
    .filter((l) => l.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name));

  return { wired: true, program: program.toBase58(), programAccounts, listings };
}

// ── Make-offer: read all OfferRecords + resolve their names ───────────────────
export interface OfferView {
  pda: string;       // the OfferRecord PDA
  buyer: string;     // who made the offer
  domainPda: string; // the NullDomain the offer targets
  name: string;      // resolved plaintext name ("" if unresolved)
  amount: bigint;    // lamports offered
}
export interface OffersSnapshot {
  offers: OfferView[];
  rpcError?: string;
}
/** Every standing offer on the cluster (OfferRecord accounts, disc 'O', dataSize 74),
 *  with names resolved. The caller filters by buyer (my offers) or owner (incoming). */
export async function readOffers(cluster: Cluster): Promise<OffersSnapshot> {
  const cfg = configFor(cluster);
  const program = new PublicKey(cfg.auction);
  const conn = connFor(cfg.rpc);
  let raw: { pubkey: PublicKey; account: { data: Uint8Array } }[];
  try {
    raw = (await gpaResilient(cluster, program, { filters: [{ dataSize: OFFER_SIZE }] })) as unknown as typeof raw;
  } catch (e) {
    return { offers: [], rpcError: e instanceof Error ? e.message : String(e) };
  }
  const recs = raw
    .filter((a) => a.account.data.length >= OFFER_SIZE && a.account.data[0] === OFFER_DISC)
    .map((a) => ({
      pda: a.pubkey.toBase58(),
      buyer: new PublicKey(a.account.data.subarray(OF_OFF_BUYER, OF_OFF_BUYER + 32)).toBase58(),
      domain: new PublicKey(a.account.data.subarray(OF_OFF_DOMAIN, OF_OFF_DOMAIN + 32)),
      amount: readU64LE(a.account.data, OF_OFF_AMOUNT),
    }));
  // Resolve domain PDAs → plaintext names (batch).
  const names = new Map<string, string>();
  for (let i = 0; i < recs.length; i += 100) {
    const slice = recs.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(slice.map((r) => r.domain));
    infos.forEach((info, j) => {
      if (info && info.data.length > 0 && info.data[0] === NULL_DOMAIN_DISC) {
        names.set(slice[j].domain.toBase58(), decodeName(info.data));
      }
    });
  }
  const offers: OfferView[] = recs
    .map((r) => ({ pda: r.pda, buyer: r.buyer, domainPda: r.domain.toBase58(), name: names.get(r.domain.toBase58()) ?? "", amount: r.amount }))
    .sort((a, b) => (b.amount > a.amount ? 1 : -1));
  return { offers };
}

// ── NullPay: resolve a .null name's published stealth meta-address ─────────────

export type StealthMetaResult =
  | { status: "found"; pda: string; meta: Uint8Array }
  | { status: "no-meta"; pda: string } // domain exists but never published a meta
  | { status: "not-found"; pda: string }; // name is unregistered on this cluster

/**
 * Resolve a `.null` name on the given cluster and read its 64-byte stealth
 * meta-address (spend_pub || view_pub) from offset 154 of the NullDomain
 * account. Returns "no-meta" if the domain exists but has not published one,
 * and "not-found" if the name is unregistered.
 */
export async function resolveStealthMeta(
  conn: Connection,
  cluster: Cluster,
  name: string,
): Promise<StealthMetaResult> {
  const cfg = configFor(cluster);
  const pda = await domainPdaFor(cfg, name);
  const pdaStr = pda.toBase58();
  const info = await conn.getAccountInfo(pda);
  if (!info || info.data.length === 0) {
    return { status: "not-found", pda: pdaStr };
  }
  const data = info.data;
  const end = ND_OFF_STEALTH_META + ND_STEALTH_META_LEN;
  if (data.length < end) {
    return { status: "no-meta", pda: pdaStr };
  }
  const meta = Uint8Array.from(data.subarray(ND_OFF_STEALTH_META, end));
  // A never-set meta is all-zero (the account was reallocated but not written).
  if (meta.every((b) => b === 0)) {
    return { status: "no-meta", pda: pdaStr };
  }
  return { status: "found", pda: pdaStr, meta };
}
