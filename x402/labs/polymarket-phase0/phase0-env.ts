import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(LAB_DIR, "..", "..", "..");

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
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required Phase 0 environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback?: string): string {
  return process.env[name] || fallback || "";
}
