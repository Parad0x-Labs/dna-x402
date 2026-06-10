/**
 * cluster.ts — the active-cluster source of truth for the web0.null portal.
 *
 * The portal talks to TWO Solana clusters:
 *   - mainnet : the live .null registrar (register / search / my-names).
 *   - devnet  : where NullPay stealth-pay + the auction are live today.
 *
 * Each cluster has its OWN program ids + RPC. Everything chain-facing reads the
 * active cluster from here (persisted in localStorage) so a single toggle re-keys
 * the whole app. Register/landing default to mainnet; /pay forces devnet.
 *
 * NOTE on PDA derivation: the mainnet registrar (H4wbFJ…) seeds the domain PDA
 * with sha256(padName64(name)). The devnet NullPay registrar (CpNbE8…) seeds it
 * with the RAW utf-8 name bytes (see scripts/nullpay/devnet-e2e.mjs). Both are
 * encoded in the per-cluster `domainSeedKind` below so callers never hard-code one.
 *
 * NOTE on the marketplace: the auction program pairs with a SPECIFIC registrar that
 * MUST use the sha256 seed (the auction derives the domain PDA with sha256). On
 * mainnet that is the same registrar as everything else (H4wbFJ). On devnet the
 * NullPay registrar (CpNbE8…) is the stale raw-seed v1, so the auction (8XsMDGRo)
 * instead pairs with the sha256-v2 registrar AVEYF2x — captured in `auctionRegistrar`
 * so the marketplace SDK uses it while NullPay keeps using `registrar`. Nothing else
 * changes; on mainnet `auctionRegistrar === registrar`.
 */

export type Cluster = "mainnet" | "devnet";

export interface ClusterConfig {
  cluster: Cluster;
  label: string;
  /** registrar program (owns .null NullDomain accounts; used by register/search/NullPay) */
  registrar: string;
  /** auction / marketplace program (resale buy-now + premium 1–3 char auctions) */
  auction: string;
  /** the registrar the AUCTION pairs with — always a sha256-seed v2 registrar.
   *  mainnet: === registrar (H4wbFJ). devnet: AVEYF2x (NOT the raw-seed NullPay one). */
  auctionRegistrar: string;
  /** default keyless RPC for this cluster (override via env) */
  rpc: string;
  /** Solana explorer cluster query-string suffix ("" for mainnet) */
  explorerSuffix: string;
  /** how this registrar derives the domain PDA seed from a name */
  domainSeedKind: "sha256" | "raw";
}

// ── mainnet (live .null registrar — verified on-chain 2026-06-08) ──────────────
const MAINNET: ClusterConfig = {
  cluster: "mainnet",
  label: "mainnet",
  registrar: "H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm",
  auction: "7uxLhqLzkEzPpkvdmTwqgL3g66yq2aMBS5QgcjaZZEaw",
  auctionRegistrar: "H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm", // === registrar on mainnet
  rpc:
    process.env.NEXT_PUBLIC_RPC_URL_MAINNET ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://solana-rpc.publicnode.com",
  explorerSuffix: "",
  domainSeedKind: "sha256",
};

// ── devnet (NullPay stealth-pay + auction live here) ──────────────────────────
const DEVNET: ClusterConfig = {
  cluster: "devnet",
  label: "devnet",
  registrar: "CpNbE8yec5UQJGTVsiTiQpKFhXfDKQZuGWMzMyFtKkME", // NullPay (raw-seed v1)
  auction: "8XsMDGRojXPp5pAVLKL1VUR4hKJbAfP1CW3jjiDo8r9e", // SOL-native auction (upgraded 2026-06-10)
  auctionRegistrar: "AVEYF2xECXcHzvrxFw4NKfaoEQwtgqrfz8NtAQXsoy7N", // sha256-v2, pairs with the auction
  rpc:
    process.env.NEXT_PUBLIC_RPC_URL_DEVNET || "https://api.devnet.solana.com",
  explorerSuffix: "?cluster=devnet",
  domainSeedKind: "raw",
};

export const CLUSTERS: Record<Cluster, ClusterConfig> = {
  mainnet: MAINNET,
  devnet: DEVNET,
};

export const DEFAULT_CLUSTER: Cluster = "mainnet";

const STORAGE_KEY = "web0.null:cluster";

/** Read the persisted cluster (browser only). Falls back to DEFAULT_CLUSTER. */
export function loadCluster(): Cluster {
  if (typeof window === "undefined") return DEFAULT_CLUSTER;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "devnet" || v === "mainnet" ? v : DEFAULT_CLUSTER;
}

/** Persist the active cluster (browser only). */
export function saveCluster(c: Cluster): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, c);
}

export function configFor(c: Cluster): ClusterConfig {
  return CLUSTERS[c];
}

/** Explorer links keyed by cluster (devnet appends ?cluster=devnet). */
export const explorerTx = (c: Cluster, sig: string): string =>
  `https://explorer.solana.com/tx/${sig}${CLUSTERS[c].explorerSuffix}`;

export const explorerAddr = (c: Cluster, addr: string): string =>
  `https://explorer.solana.com/address/${addr}${CLUSTERS[c].explorerSuffix}`;
