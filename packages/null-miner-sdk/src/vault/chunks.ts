/**
 * null-miner-sdk — Dark Agent Vault: chunk splitting and decoy mixing
 *
 * Splits the encrypted vault blob into fixed-size chunks and pads the
 * array with indistinguishable decoy chunks. The server stores all chunks
 * shuffled — without the client-side manifest it cannot identify which
 * chunks are real or reconstruct the ciphertext ordering.
 */

import { sha256 } from "@noble/hashes/sha256";
import type {
  EncryptedVaultBlob,
  VaultChunk,
  DecoyChunk,
  VaultChunkManifest,
  StoredVaultRow,
  VaultMetadata,
} from "./types.js";
import { uint8ToHex, hexToUint8 } from "./crypto.js";

const CHUNK_SIZE  = 64; // bytes per chunk
const DECOY_COUNT = 4;  // default number of decoy chunks

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256Hex(data: Uint8Array): string {
  return uint8ToHex(sha256(data));
}

function makeChunkId(vaultId: string, index: number): string {
  return sha256Hex(new TextEncoder().encode(`${vaultId}:chunk:${index}`)).slice(0, 32);
}

function makeIndexCommitment(vaultId: string, index: number): string {
  return sha256Hex(new TextEncoder().encode(`${vaultId}:index:${index}`));
}

/** Compute the vault commitment: SHA-256(iv_bytes ++ ciphertext). */
export function computeVaultCommitment(vault: EncryptedVaultBlob): string {
  const ivBytes = hexToUint8(vault.iv);
  const combined = new Uint8Array(ivBytes.length + vault.ciphertext.length);
  combined.set(ivBytes, 0);
  combined.set(vault.ciphertext, ivBytes.length);
  return sha256Hex(combined);
}

/** Deterministic Fisher-Yates shuffle seeded from the vaultCommitment hex string. */
function seededShuffle<T>(arr: T[], seed: string): T[] {
  const result = [...arr];
  // 4-byte LCG seed from leading hex digits
  let rng = parseInt(seed.slice(0, 8), 16) >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    rng = ((Math.imul(rng, 1664525) + 1013904223) >>> 0);
    const j = Math.floor((rng / 0x100000000) * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Split an encrypted vault blob into fixed-size chunks and add decoys.
 *
 * Real and decoy chunks are shuffled using the vault commitment as seed.
 * The returned `manifest` must be kept client-side — it maps real chunk IDs
 * back to their ordering and is required for reassembly.
 */
export function splitVaultBlob(
  vault: EncryptedVaultBlob,
  options?: { decoyCount?: number; chunkSize?: number },
): {
  realChunks:  VaultChunk[];
  decoyChunks: DecoyChunk[];
  allChunks:   (VaultChunk | DecoyChunk)[];
  manifest:    VaultChunkManifest;
} {
  const chunkSize  = options?.chunkSize  ?? CHUNK_SIZE;
  const decoyCount = options?.decoyCount ?? DECOY_COUNT;
  const { vaultId } = vault;

  // Pad ciphertext to multiple of chunkSize
  const totalBytes = vault.ciphertext.length;
  const padded     = new Uint8Array(Math.ceil(totalBytes / chunkSize) * chunkSize);
  padded.set(vault.ciphertext);

  // Real chunks
  const realChunks: VaultChunk[] = [];
  for (let i = 0; i < padded.length; i += chunkSize) {
    const slice      = padded.slice(i, i + chunkSize);
    const hexSlice   = uint8ToHex(slice);
    const index      = i / chunkSize;
    realChunks.push({
      chunkId:          makeChunkId(vaultId, index),
      vaultId,
      indexCommitment:  makeIndexCommitment(vaultId, index),
      ciphertextChunk:  hexSlice,
      chunkHash:        sha256Hex(new TextEncoder().encode(hexSlice)),
      isDecoy:          false,
    });
  }

  // Shuffle real + decoy using vault commitment as seed
  const commitment = computeVaultCommitment(vault);

  // Decoy chunks — IDs and content are deterministically derived from the vault
  // commitment so that splitVaultBlob is idempotent for the same vault blob.
  const decoyChunks: DecoyChunk[] = [];
  for (let d = 0; d < decoyCount; d++) {
    // Deterministic pseudo-random bytes for decoy content: SHA-256(commitment + ":decoy:" + d)
    const decoyContentSeed = new TextEncoder().encode(`${commitment}:decoy-content:${d}`);
    const decoyContentHash = sha256Hex(decoyContentSeed);
    // Repeat the hash to fill chunkSize bytes, then hex-encode
    const decoyBytes = new Uint8Array(chunkSize);
    const hashBytes  = new Uint8Array(32);
    for (let b = 0; b < 32; b++) hashBytes[b] = parseInt(decoyContentHash.slice(b * 2, b * 2 + 2), 16);
    for (let b = 0; b < chunkSize; b++) decoyBytes[b] = hashBytes[b % 32]!;
    const hexRnd  = uint8ToHex(decoyBytes);
    // Deterministic decoy ID: SHA-256(commitment + ":decoy-id:" + d)
    const decoyId = sha256Hex(new TextEncoder().encode(`${commitment}:decoy-id:${d}`)).slice(0, 32);
    decoyChunks.push({
      chunkId:         decoyId,
      vaultId,
      ciphertextChunk: hexRnd,
      chunkHash:       sha256Hex(new TextEncoder().encode(hexRnd)),
      isDecoy:         true,
    });
  }
  const allChunks  = seededShuffle([...realChunks, ...decoyChunks], commitment);

  const manifest: VaultChunkManifest = {
    vaultId,
    walletPubkey: vault.walletPubkey,
    agentPubkey:  vault.agentPubkey,
    appDomain:    vault.appDomain,
    version:      vault.version,
    realChunkIds: realChunks.map(c => c.chunkId),
    totalBytes,
    iv:           vault.iv,
    aadHash:      vault.aadHash,
    salt:         vault.salt,
  };

  return { realChunks, decoyChunks, allChunks, manifest };
}

/**
 * Reconstruct an EncryptedVaultBlob from stored chunks using the manifest.
 *
 * Throws if any real chunk referenced by the manifest is missing.
 * Decoy chunks are silently ignored.
 */
export function assembleVaultBlob(
  chunks: (VaultChunk | DecoyChunk)[],
  manifest: VaultChunkManifest,
): EncryptedVaultBlob {
  const byId = new Map<string, VaultChunk | DecoyChunk>();
  for (const c of chunks) byId.set(c.chunkId, c);

  const orderedFragments: Uint8Array[] = [];
  for (const id of manifest.realChunkIds) {
    const chunk = byId.get(id);
    if (!chunk) {
      throw new Error(`assembleVaultBlob: missing chunk "${id}"`);
    }
    orderedFragments.push(hexToUint8(chunk.ciphertextChunk));
  }

  // Concatenate and trim padding
  const raw = new Uint8Array(orderedFragments.reduce((acc, f) => acc + f.length, 0));
  let offset = 0;
  for (const frag of orderedFragments) {
    raw.set(frag, offset);
    offset += frag.length;
  }
  const ciphertext = raw.slice(0, manifest.totalBytes);

  return {
    ciphertext,
    iv:           manifest.iv,
    aadHash:      manifest.aadHash,
    version:      manifest.version,
    walletPubkey: manifest.walletPubkey,
    agentPubkey:  manifest.agentPubkey,
    vaultId:      manifest.vaultId,
    appDomain:    manifest.appDomain,
    salt:         manifest.salt,
  };
}

/**
 * Build the server-side storage row from an encrypted vault + chunks.
 * Validates that no secret material is present.
 */
export function buildStoredVaultRow(
  vault: EncryptedVaultBlob,
  allChunks: (VaultChunk | DecoyChunk)[],
  options?: { receiptHash?: string; nullifierCommitment?: string },
): StoredVaultRow {
  return {
    vaultId:          vault.vaultId,
    ownerWalletPubkey: vault.walletPubkey,
    agentPubkey:      vault.agentPubkey,
    vaultCommitment:  computeVaultCommitment(vault),
    allChunks,
    salt:             vault.salt,
    iv:               vault.iv,
    aadHash:          vault.aadHash,
    version:          vault.version,
    createdAt:        Date.now(),
    receiptHash:      options?.receiptHash,
    nullifierCommitment: options?.nullifierCommitment,
  };
}

/** Build public-facing vault metadata for Dark Passport / x402 binding. */
export function buildVaultMetadata(
  vault: EncryptedVaultBlob,
  options?: {
    nullifierSeed?: string;
    nullifierCommitment?: string;
    receiptHash?: string;
  },
): VaultMetadata {
  const commitment = computeVaultCommitment(vault);
  return {
    vaultCommitment:     commitment,
    agentPubkey:         vault.agentPubkey,
    walletPubkey:        vault.walletPubkey,
    nullifierSeed:       options?.nullifierSeed,
    nullifierCommitment: options?.nullifierCommitment,
    receiptHash:         options?.receiptHash,
    x402ActivationReceipt: {
      vaultId:         vault.vaultId,
      agentPubkey:     vault.agentPubkey,
      walletPubkey:    vault.walletPubkey,
      vaultCommitment: commitment,
      activatedAt:     Date.now(),
    },
  };
}
