/**
 * Permanent archive: Liquefy compress → AES-256-GCM encrypt → Arweave via Irys → Solana anchor.
 *
 * Privacy model:
 *   - Arweave stores encrypted ciphertext — public but unreadable without the key
 *   - Solana stores the Merkle root of the PLAINTEXT + the Arweave tx ID
 *   - The root proves the batch existed and is structured correctly, without revealing content
 *   - ZK proofs check against the on-chain root — agent proves properties without revealing data
 *
 * No server. No S3. No database. Nothing to delete. Nothing to subpoena.
 *
 * Cost at 10k receipts:
 *   Liquefy compress     → ~20KB   : $0.00 (local)
 *   Irys/Arweave upload  → ~20KB   : ~$0.0003
 *   Solana anchor        → 34 bytes: ~$0.0007
 *   Total                          : ~$0.001 per 10k agent receipts
 */

import { createHash, randomBytes } from "node:crypto";
import type { X402Receipt } from "./compress.js";
import { compressReceipts } from "./compress.js";
import { buildReceiptRoot, rootHex } from "./merkle.js";

// ── AES-256-GCM helpers (WebCrypto — works in browser + Node 22) ──────────────

const subtle = (globalThis.crypto ?? (await import("node:crypto")).webcrypto).subtle;

export async function generateArchiveKey(): Promise<Uint8Array> {
  const k = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return new Uint8Array(await subtle.exportKey("raw", k));
}

export async function encryptBlob(blob: Uint8Array, rawKey: Uint8Array): Promise<{
  ciphertext: Uint8Array;
  nonce:      Uint8Array;
}> {
  const key   = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const nonce = randomBytes(12);
  const ct    = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, blob));
  return { ciphertext: ct, nonce };
}

export async function decryptBlob(ciphertext: Uint8Array, nonce: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
}

/** Serialize nonce + ciphertext into one uploadable blob. */
export function packEncrypted(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, 12);
  return out;
}

export function unpackEncrypted(packed: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  return { nonce: packed.slice(0, 12), ciphertext: packed.slice(12) };
}

// ── Archive result ────────────────────────────────────────────────────────────

export interface ArchiveResult {
  /** Arweave transaction ID — permanent pointer to the encrypted blob */
  arweaveTxId:   string;
  /** SHA-256 of the compressed plaintext — what goes on Solana */
  merkleRoot:    string; // 64-char hex
  /** Compressed plaintext size (before encryption) */
  compressedBytes: number;
  /** Uploaded size (nonce + ciphertext) */
  uploadedBytes:   number;
  /** Original receipts size estimate */
  originalBytes:   number;
  /** Receipt count */
  count:           number;
  /** Arweave explorer URL */
  arweaveUrl:      string;
}

// ── Core archive function ─────────────────────────────────────────────────────

/**
 * Compress, encrypt, upload to Arweave, return Merkle root for Solana anchoring.
 *
 * @param receipts   Array of x402 receipts
 * @param rawKey     32-byte AES-256 key (agent holds this — never uploaded)
 * @param irysOptions Optional Irys configuration (defaults to mainnet)
 * @returns ArchiveResult with Arweave tx ID and Merkle root for Solana
 */
export async function archiveReceipts(
  receipts: X402Receipt[],
  rawKey: Uint8Array,
  irysOptions?: { network?: "mainnet" | "devnet"; rpcUrl?: string; solanaKeypairPath?: string },
): Promise<ArchiveResult> {
  if (receipts.length === 0) throw new Error("No receipts to archive");

  // 1. Compress with Liquefy Columnar Gun
  const compressed = compressReceipts(receipts);

  // 2. Build Merkle root of the PLAINTEXT (this goes on Solana — proves structure without content)
  const root    = buildReceiptRoot(receipts);
  const rootStr = rootHex(root);

  // 3. Encrypt for Arweave (Arweave stores ciphertext — unreadable without the key)
  const { ciphertext, nonce } = await encryptBlob(compressed, rawKey);
  const packed = packEncrypted(nonce, ciphertext);

  const originalBytes = new TextEncoder().encode(JSON.stringify(receipts)).length;

  // 4. Upload to Arweave via Irys
  const { default: Irys } = await import("@irys/sdk");

  // Load the Solana keypair from the CLI wallet
  const { execSync, readFileSync } = await import("node:child_process").then(m => m).catch(() => null as any);
  const { Keypair }                = await import("@solana/web3.js");

  let solanaKey: Uint8Array;
  try {
    const keyPath = execSync("solana config get", { encoding: "utf8" })
      .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
    solanaKey = Uint8Array.from(JSON.parse(readFileSync(keyPath!, "utf8")));
  } catch {
    throw new Error("Solana CLI keypair not found. Configure solana CLI with your wallet.");
  }

  const network = irysOptions?.network ?? "mainnet";
  const irys = new Irys({
    network,
    token: "solana",
    key: Buffer.from(solanaKey).toString("hex"),
    config: irysOptions?.rpcUrl
      ? { providerUrl: irysOptions.rpcUrl }
      : undefined,
  });

  const uploadReceipt = await irys.upload(Buffer.from(packed), {
    tags: [
      { name: "Content-Type",        value: "application/liquefy-encrypted" },
      { name: "Liquefy-Version",     value: "0.2.2" },
      { name: "Receipt-Count",       value: String(receipts.length) },
      { name: "Merkle-Root",         value: rootStr },
      { name: "Compression-Ratio",   value: String(Math.round(originalBytes / compressed.length)) + "x" },
      { name: "App",                 value: "dna-x402" },
    ],
  });

  return {
    arweaveTxId:     uploadReceipt.id,
    merkleRoot:      rootStr,
    compressedBytes: compressed.length,
    uploadedBytes:   packed.length,
    originalBytes,
    count:           receipts.length,
    arweaveUrl:      `https://arweave.net/${uploadReceipt.id}`,
  };
}
