import { ClusterLabel, RuntimeConfig } from "./types";

const STORAGE_KEY = "dnp-agent-control-config-v1";
const DEFAULT_POLL_MS = 1500;

function normalizeCluster(value: string | undefined): ClusterLabel {
  if (!value) {
    return "devnet";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "mainnet-beta") {
    return "mainnet-beta";
  }
  if (normalized === "local" || normalized === "localhost" || normalized === "localnet") {
    return "localnet";
  }
  return "devnet";
}

function toPositiveMs(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numberValue) || numberValue < 250) {
    return fallback;
  }
  return Math.round(numberValue);
}

function cleanUrl(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/\/$/, "");
}

export function defaultRuntimeConfig(): RuntimeConfig {
  const env = import.meta.env;
  return {
    x402BaseUrl: cleanUrl(env.VITE_X402_BASE_URL, "http://localhost:8080"),
    walletUrl: cleanUrl(env.VITE_WALLET_URL, "http://localhost:5173"),
    cluster: normalizeCluster(env.VITE_CLUSTER),
    pollIntervalMs: DEFAULT_POLL_MS,
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const defaults = defaultRuntimeConfig();
  if (typeof window === "undefined") {
    return defaults;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
    return {
      x402BaseUrl: cleanUrl(parsed.x402BaseUrl, defaults.x402BaseUrl),
      walletUrl: cleanUrl(parsed.walletUrl, defaults.walletUrl),
      cluster: normalizeCluster(parsed.cluster),
      pollIntervalMs: toPositiveMs(parsed.pollIntervalMs, defaults.pollIntervalMs),
    };
  } catch {
    return defaults;
  }
}

export function saveRuntimeConfig(config: RuntimeConfig): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clusterRpc(cluster: ClusterLabel): string {
  if (cluster === "mainnet-beta") {
    return "https://api.mainnet-beta.solana.com";
  }
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  return "https://api.devnet.solana.com";
}

export function explorerClusterParam(cluster: ClusterLabel): string {
  if (cluster === "mainnet-beta") {
    return "";
  }
  if (cluster === "localnet") {
    return "custom";
  }
  return "devnet";
}
