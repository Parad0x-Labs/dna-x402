/**
 * null-miner-sdk — Dark Agent Vault: browser-safe re-export
 *
 * This module re-exports only the WebCrypto-based vault API.
 * No Node.js `crypto` module is imported anywhere in this chain.
 *
 * Compatible with: Chrome 92+, Firefox 90+, Safari 15+, Node 18+.
 *
 * Note: "browser-safe" means safe against *backend/database leaks*, not a
 * compromised frontend. If the browser's JavaScript is malicious, no
 * client-side encryption can protect private keys.
 */

export {
  VAULT_VERSION,
  createVaultChallenge,
  encryptAgentKey,
  decryptAgentKey,
  generateVaultSalt,
  uint8ToHex,
  hexToUint8,
  uint8ToBase64,
  base64ToUint8,
} from "./crypto.js";

export {
  splitVaultBlob,
  assembleVaultBlob,
  buildStoredVaultRow,
  buildVaultMetadata,
  computeVaultCommitment,
} from "./chunks.js";

export type {
  VaultParams,
  VaultChallengeInput,
  EncryptedVaultBlob,
  VaultChunk,
  DecoyChunk,
  VaultChunkManifest,
  StoredVaultRow,
  VaultMetadata,
} from "./types.js";
