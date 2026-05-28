/**
 * null-miner-sdk — Dark Agent Vault: type definitions
 *
 * Server-breach-safe agent wallet storage.
 * The server NEVER receives a raw agent key, Phantom key, derived encryption key,
 * seed phrase, or plaintext vault payload.
 */

export const VAULT_VERSION = "dark-agent-vault-v1" as const;
export type VaultVersionString = typeof VAULT_VERSION;

/** Parameters that bind the vault to a specific owner + context. */
export interface VaultParams {
  walletPubkey: string;
  agentPubkey: string;
  vaultId: string;
  appDomain: string;
  version?: string;
}

/** Input to `createVaultChallenge`. */
export interface VaultChallengeInput extends VaultParams {}

/** Encrypted vault blob — produced by `encryptAgentKey`, stored in chunks server-side. */
export interface EncryptedVaultBlob {
  /** AES-256-GCM ciphertext (includes 16-byte auth tag appended). Uint8Array. */
  ciphertext: Uint8Array;
  /** AES-GCM IV — hex, 12 bytes. */
  iv: string;
  /** SHA-256 of the AAD — hex. Stored for tamper-detection. */
  aadHash: string;
  version: string;
  walletPubkey: string;
  agentPubkey: string;
  vaultId: string;
  appDomain: string;
  /** HKDF salt — hex, 32 bytes. Stored so the key can be re-derived from a signature. */
  salt: string;
}

/** A real encrypted chunk of vault data. */
export interface VaultChunk {
  chunkId: string;
  vaultId: string;
  /** SHA-256(vaultId + ":index:" + chunkIndex) hex — proves position without leaking it. */
  indexCommitment: string;
  /** Hex-encoded fragment of the vault ciphertext. */
  ciphertextChunk: string;
  /** SHA-256(ciphertextChunk hex) — integrity check. */
  chunkHash: string;
  isDecoy: false;
}

/** An indistinguishable-from-real noise chunk. */
export interface DecoyChunk {
  chunkId: string;
  vaultId: string;
  /** Hex-encoded random bytes (same chunk size). */
  ciphertextChunk: string;
  /** SHA-256(ciphertextChunk hex). */
  chunkHash: string;
  isDecoy: true;
}

/**
 * Client-side manifest — tells the client which chunks are real and in what order.
 * NEVER sent to the server; kept in browser storage alongside encrypted blobs.
 */
export interface VaultChunkManifest {
  vaultId: string;
  walletPubkey: string;
  agentPubkey: string;
  appDomain: string;
  version: string;
  /** Ordered list of real chunk IDs (index 0 = first ciphertext fragment). */
  realChunkIds: string[];
  /** Total byte length of the ciphertext for trimming padded last chunk. */
  totalBytes: number;
  iv: string;
  aadHash: string;
  salt: string;
}

/**
 * What the server stores. Contains NO secret material.
 * Encrypted chunks + decoys are shuffled so server cannot distinguish real from noise.
 */
export interface StoredVaultRow {
  vaultId: string;
  ownerWalletPubkey: string;
  agentPubkey: string;
  /** SHA-256(iv_bytes ++ ciphertext) hex — commitment without ciphertext disclosure. */
  vaultCommitment: string;
  /** Real + decoy chunks, shuffled. Server cannot distinguish. */
  allChunks: (VaultChunk | DecoyChunk)[];
  salt: string;
  iv: string;
  aadHash: string;
  version: string;
  createdAt: number;
  receiptHash?: string;
  nullifierCommitment?: string;
}

/** Public metadata for Dark Passport / x402 binding. No raw key material. */
export interface VaultMetadata {
  vaultCommitment: string;
  agentPubkey: string;
  walletPubkey: string;
  nullifierSeed?: string;
  nullifierCommitment?: string;
  receiptHash?: string;
  x402ActivationReceipt?: {
    vaultId: string;
    agentPubkey: string;
    walletPubkey: string;
    vaultCommitment: string;
    activatedAt: number;
  };
}
