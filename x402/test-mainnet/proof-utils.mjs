import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function assertWorkspacePath(filePath) {
  const resolved = path.resolve(filePath);
  const root = `${WORKSPACE_ROOT}${path.sep}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(root)) {
    throw new Error(`path escapes workspace: ${resolved}`);
  }
  return resolved;
}

export function defaultKeysDir(cluster) {
  return assertWorkspacePath(path.join(__dirname, "keys", cluster));
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(assertWorkspacePath(filePath), "utf8"));
}

export function writeJsonFile(filePath, value) {
  const resolved = assertWorkspacePath(filePath);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadKeypair(filePath) {
  const raw = readJson(filePath);
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    throw new Error(`invalid Solana keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function writeKeypairIfMissing(filePath) {
  const resolved = assertWorkspacePath(filePath);
  if (fs.existsSync(resolved)) {
    return loadKeypair(resolved);
  }
  ensureDir(path.dirname(resolved));
  const keypair = Keypair.generate();
  fs.writeFileSync(resolved, `${JSON.stringify(Array.from(keypair.secretKey))}\n`);
  return keypair;
}

export function keypairSecretBase58(keypair) {
  return bs58.encode(keypair.secretKey);
}

export function publicKeyForFile(filePath) {
  return loadKeypair(filePath).publicKey.toBase58();
}

export function isBase58Signature(value) {
  return typeof value === "string"
    && value.length >= 80
    && value.length <= 100
    && BASE58_RE.test(value);
}

export function shortBase58(value, head = 12, tail = 8) {
  if (typeof value !== "string" || value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function assertValidSignatures(signatures, label) {
  const invalid = signatures
    .map((signature, index) => ({ signature, index }))
    .filter((entry) => !isBase58Signature(entry.signature));
  if (invalid.length > 0) {
    throw new Error(`${label} contains invalid tx signatures: ${invalid.map((entry) => `${entry.index}:${String(entry.signature)}`).join(", ")}`);
  }
}

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|timeout|econnreset|fetch failed|socket|websocket/i.test(message);
}

export async function confirmSignatures(connection, signatures, label, options = {}) {
  const unique = Array.from(new Set(signatures.filter(Boolean)));
  assertValidSignatures(unique, label);
  if (unique.length === 0) {
    return [];
  }

  const timeoutMs = options.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(unique);
  const confirmed = new Set();
  const failed = [];
  let pollMs = options.initialPollMs ?? 1_000;

  while (pending.size > 0 && Date.now() < deadline) {
    const batch = Array.from(pending).slice(0, 256);
    let value;
    try {
      ({ value } = await connection.getSignatureStatuses(batch, {
        searchTransactionHistory: true,
      }));
    } catch (error) {
      if (!isRetryableRpcError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 10_000);
      continue;
    }

    for (let i = 0; i < batch.length; i += 1) {
      const signature = batch[i];
      const status = value[i];
      if (!status) {
        continue;
      }
      if (status.err) {
        failed.push({ signature, err: status.err });
        pending.delete(signature);
        continue;
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        confirmed.add(signature);
        pending.delete(signature);
      }
    }

    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 10_000);
    }
  }

  if (failed.length > 0) {
    throw new Error(`${label} has failed transactions: ${failed.map((entry) => `${entry.signature}:${JSON.stringify(entry.err)}`).join(", ")}`);
  }
  if (pending.size > 0) {
    throw new Error(`${label} confirmation timeout for ${pending.size} signature(s): ${Array.from(pending).map((sig) => shortBase58(sig)).join(", ")}`);
  }
  return Array.from(confirmed);
}

export function assertNoBrokenSolscanLinks(markdown, label) {
  const broken = markdown.match(/solscan\.io\/tx\/(?:undefined|null|\s|\))/gi) ?? [];
  if (broken.length > 0) {
    throw new Error(`${label} contains broken Solscan links: ${broken.join(", ")}`);
  }
}

export function assertPublicKey(value, label) {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana public key: ${value}`);
  }
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}
