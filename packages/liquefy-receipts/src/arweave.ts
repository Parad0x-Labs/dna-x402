/**
 * Permanent archive: Liquefy compress → AES-256-GCM encrypt → Arweave via Irys → Solana anchor.
 *
 * Privacy model:
 *   - Arweave stores encrypted ciphertext — public but unreadable without the key
 *   - The encrypted blob carries a per-batch secret S. Every Merkle leaf is a
 *     SALTED commitment SHA-256(0x00 || 0x02 || salt_i || canonical(receipt_i)),
 *     salt_i = HKDF(S, i). Without S the public on-chain root cannot be
 *     brute-forced from low-entropy receipt fields (amount, sender, timestamp …).
 *   - Solana stores that salted Merkle root + the Arweave tx ID — proving the
 *     batch existed and is well-structured, without revealing content.
 *   - To open one receipt the key holder reveals (salt_i, receipt_i) + its path;
 *     all other leaves stay hidden.
 *
 * Note: the ZK membership proofs are a SEPARATE construction (Poseidon over
 * receipt commitments in null-miner-sdk/src/zk), not this SHA-256 archive root.
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

// ── Archive plaintext framing: [batchSecret(32) || compressed] ────────────────
// The per-batch salt secret is encrypted TOGETHER with the compressed blob, so
// the key holder recovers it on decrypt to re-derive per-leaf salts and open
// inclusion proofs. It must never appear on-chain or in an Arweave tag.

/** Byte length of the per-batch secret prepended to the compressed blob before encryption. */
export const ARCHIVE_BATCH_SECRET_BYTES = 32;

/** Frame the per-batch salt secret in front of the compressed blob (encrypted together). */
export function packArchivePlaintext(batchSecret: Uint8Array, compressed: Uint8Array): Uint8Array {
  if (batchSecret.length !== ARCHIVE_BATCH_SECRET_BYTES) {
    throw new RangeError(`batchSecret must be ${ARCHIVE_BATCH_SECRET_BYTES} bytes, got ${batchSecret.length}`);
  }
  const out = new Uint8Array(ARCHIVE_BATCH_SECRET_BYTES + compressed.length);
  out.set(batchSecret, 0);
  out.set(compressed, ARCHIVE_BATCH_SECRET_BYTES);
  return out;
}

/** Split a decrypted archive plaintext back into the per-batch secret and the compressed blob. */
export function unpackArchivePlaintext(plaintext: Uint8Array): { batchSecret: Uint8Array; compressed: Uint8Array } {
  return {
    batchSecret: plaintext.slice(0, ARCHIVE_BATCH_SECRET_BYTES),
    compressed:  plaintext.slice(ARCHIVE_BATCH_SECRET_BYTES),
  };
}

// ── Archive result ────────────────────────────────────────────────────────────

export interface ArchiveResult {
  /** Arweave transaction ID — permanent pointer to the encrypted blob */
  arweaveTxId:   string;
  /** Salted SHA-256 Merkle root over the receipts — what goes on Solana */
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

  // 2. Fresh per-batch secret S. Blinds every Merkle leaf so the PUBLIC on-chain
  //    root can't be brute-forced from low-entropy receipt fields. S is stored
  //    ONLY inside the encrypted blob below — never on-chain, never in a tag.
  const batchSecret = randomBytes(32);

  // 3. Salted Merkle root (this goes on Solana — proves structure without content)
  const root    = buildReceiptRoot(receipts, batchSecret);
  const rootStr = rootHex(root);

  // 4. Encrypt [S || compressed] for Arweave. The key holder recovers S to
  //    derive per-leaf salts and open inclusion proofs; the public sees only ciphertext.
  const { ciphertext, nonce } = await encryptBlob(packArchivePlaintext(batchSecret, compressed), rawKey);
  const packed = packEncrypted(nonce, ciphertext);

  const originalBytes = new TextEncoder().encode(JSON.stringify(receipts)).length;

  // 5. Upload to Arweave via Irys
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
