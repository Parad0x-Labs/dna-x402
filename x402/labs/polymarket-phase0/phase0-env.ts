import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(LAB_DIR, "..", "..", "..");

const ENV_ALIASES: Record<string, string[]> = {
  POLYMARKET_BUILDER_CODE: ["POLY_BUILDER_CODE"],
  POLYMARKET_BUILDER_API_KEY: ["POLYMARKET_API_KEY"],
  POLYMARKET_BUILDER_SECRET: ["POLYMARKET_API_SECRET"],
  POLYMARKET_BUILDER_PASSPHRASE: ["POLYMARKET_API_PASSPHRASE"],
};

const PHASE0_BROWSER_REQUIRED_ENV = [
  "POLYMARKET_RELAYER_URL",
  "POLYMARKET_CLOB_API_URL",
  "POLYMARKET_RPC_URL",
  "POLYMARKET_OWNER_SIGNER_SOURCE",
  "POLYMARKET_BUILDER_CODE",
  "POLYMARKET_BUILDER_API_KEY",
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
] as const;

const PHASE0_LIVE_ORDER_EXTRA_ENV = [
  "POLYMARKET_PRIVATE_KEY",
  "DEPOSIT_WALLET_ADDRESS",
] as const;

function acceptedEnvNames(name: string): string[] {
  return [name, ...(ENV_ALIASES[name] ?? [])];
}

function envValue(name: string): string | undefined {
  for (const candidate of acceptedEnvNames(name)) {
    const value = process.env[candidate];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function envSourceName(name: string): string | undefined {
  for (const candidate of acceptedEnvNames(name)) {
    const value = process.env[candidate];
    if (value && value.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function missingEnvMessage(name: string): string {
  const accepted = acceptedEnvNames(name);
  if (accepted.length === 1) {
    return `Missing required Phase 0 environment variable: ${name}`;
  }
  return `Missing required Phase 0 environment variable: ${name} (accepted aliases: ${accepted.slice(1).join(", ")})`;
}

export interface Phase0EnvReadinessEntry {
  canonicalName: string;
  acceptedNames: string[];
  present: boolean;
  sourceName?: string;
}

export interface Phase0EnvReadiness {
  browserHarness: Phase0EnvReadinessEntry[];
  liveOrderFlowExtras: Phase0EnvReadinessEntry[];
}

export function loadEnvFile(envPath: string): boolean {
  if (!existsSync(envPath)) {
    return false;
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  return true;
}

export function loadPhase0Env(): string[] {
  const loaded: string[] = [];
  const localEnv = resolve(LAB_DIR, ".env.local");
  if (loadEnvFile(localEnv)) {
    loaded.push(localEnv);
  }
  const importPath = process.env.POLYMARKET_PHASE0_IMPORT_ENV_PATH;
  if (importPath && loadEnvFile(importPath)) {
    loaded.push(importPath);
  }
  return loaded;
}

export function requireEnv(name: string): string {
  const value = envValue(name);
  if (!value) {
    throw new Error(missingEnvMessage(name));
  }
  return value;
}

export function optionalEnv(name: string, fallback?: string): string {
  return envValue(name) || fallback || "";
}

export function assertPhase0BrowserEnvReady(): void {
  const missing = PHASE0_BROWSER_REQUIRED_ENV.filter((name) => !envValue(name));
  if (missing.length === 0) {
    return;
  }
  const lines = missing.map((name) => `- ${missingEnvMessage(name)}`);
  throw new Error(`Missing required Phase 0 browser environment variables:\n${lines.join("\n")}`);
}

export function getPhase0EnvReadiness(): Phase0EnvReadiness {
  const toEntry = (canonicalName: string): Phase0EnvReadinessEntry => ({
    canonicalName,
    acceptedNames: acceptedEnvNames(canonicalName),
    present: Boolean(envValue(canonicalName)),
    sourceName: envSourceName(canonicalName),
  });

  return {
    browserHarness: PHASE0_BROWSER_REQUIRED_ENV.map((name) => toEntry(name)),
    liveOrderFlowExtras: PHASE0_LIVE_ORDER_EXTRA_ENV.map((name) => toEntry(name)),
  };
}
