/**
 * null-miner-sdk — Dark Agent Vault: WebCrypto key derivation & AES-256-GCM
 *
 * Uses the WebCrypto API (crypto.subtle) only — available in all modern browsers
 * and Node 18+. Zero Node-only `crypto` module imports.
 *
 * Security layers:
 *   1. HKDF-SHA256(signature, salt, info) → AES-256-GCM key
 *      - info = appDomain|walletPubkey|vaultId|agentPubkey|version
 *      - Wrong wallet → different 64-byte signature → different key → auth fail
 *      - Wrong domain/vault/agent → different HKDF info → different key → auth fail
 *   2. AAD binds the same params to the GCM tag
 *      - Tampered ciphertext → auth tag mismatch → DOMException
 *   3. Inner envelope double-checks pubkeys after decryption
 */

import type { VaultParams, VaultChallengeInput, EncryptedVaultBlob } from "./types.js";
export { VAULT_VERSION } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sub = (): any => (globalThis as any).crypto.subtle;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webCrypto = (): any => (globalThis as any).crypto;

// ── Challenge ─────────────────────────────────────────────────────────────────

/**
 * Canonical UTF-8 message the user signs with Phantom.
 * Fully deterministic — no timestamp — so the same Phantom wallet can
 * re-derive the vault key at any future point just by signing again.
 */
export function createVaultChallenge(input: VaultChallengeInput): string {
  return (
    `Dark Agent Vault v1\n` +
    `Domain: ${input.appDomain}\n` +
    `Wallet: ${input.walletPubkey}\n` +
    `Agent: ${input.agentPubkey}\n` +
    `Vault: ${input.vaultId}\n` +
    `Purpose: Encrypt/decrypt local agent wallet only\n` +
    `Warning: This is not a transaction`
  );
}

// ── HKDF key derivation ───────────────────────────────────────────────────────

/** Derive the 32-byte AES-256-GCM key from a Phantom signMessage signature. */
async function deriveVaultKey(
  signature: Uint8Array,
  salt: Uint8Array,
  params: VaultParams,
): Promise<unknown> {
  const version = params.version ?? "dark-agent-vault-v1";
  const info = new TextEncoder().encode(
    `${params.appDomain}|${params.walletPubkey}|${params.vaultId}|${params.agentPubkey}|${version}`
  );
  const ikm = await sub().importKey("raw", signature, { name: "HKDF" }, false, ["deriveKey"]);
  return sub().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── AAD ───────────────────────────────────────────────────────────────────────

function buildAAD(params: VaultParams): Uint8Array {
  const version = params.version ?? "dark-agent-vault-v1";
  return new TextEncoder().encode(
    `${version}|${params.walletPubkey}|${params.agentPubkey}|${params.vaultId}|${params.appDomain}`
  );
}

// ── SHA-256 via WebCrypto ─────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest: ArrayBuffer = await sub().digest("SHA-256", data);
  return uint8ToHex(new Uint8Array(digest));
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt the agent secret key using a vault key derived from a Phantom signature.
 *
 * @param agentSecretKey  - raw agent private key (32 bytes for ed25519)
 * @param signature       - 64-byte Phantom signMessage result
 * @param salt            - 32-byte random HKDF salt (call generateVaultSalt())
 * @param params          - vault identity params
 */
export async function encryptAgentKey(
  agentSecretKey: Uint8Array,
  signature: Uint8Array,
  salt: Uint8Array,
  params: VaultParams,
): Promise<EncryptedVaultBlob> {
  const version = params.version ?? "dark-agent-vault-v1";
  const key     = await deriveVaultKey(signature, salt, params);
  const aad     = buildAAD(params);
  const iv      = webCrypto().getRandomValues(new Uint8Array(12));

  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      version,
      agentSecretKeyBase64: uint8ToBase64(agentSecretKey),
      agentPubkey:  params.agentPubkey,
      walletPubkey: params.walletPubkey,
      vaultId:      params.vaultId,
      createdAt:    Date.now(),
    }),
  );

  const encBuf: ArrayBuffer = await sub().encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    plaintext,
  );
  const ciphertext = new Uint8Array(encBuf);
  const aadHash    = await sha256Hex(aad);

  return {
    ciphertext,
    iv:           uint8ToHex(iv),
    aadHash,
    version,
    walletPubkey: params.walletPubkey,
    agentPubkey:  params.agentPubkey,
    vaultId:      params.vaultId,
    appDomain:    params.appDomain,
    salt:         uint8ToHex(salt),
  };
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypt the agent secret key from an encrypted vault blob.
 *
 * Throws on wrong wallet (different signature → different HKDF key → GCM auth fail),
 * wrong domain/vault/agent (different HKDF info → different key → GCM auth fail),
 * or tampered ciphertext (GCM auth tag mismatch).
 *
 * The returned key only exists in memory — do not log or persist it.
 */
export async function decryptAgentKey(
  vault: EncryptedVaultBlob,
  signature: Uint8Array,
  params: VaultParams,
): Promise<Uint8Array> {
  // Early parameter consistency check — fails fast if metadata was altered
  if (
    vault.walletPubkey !== params.walletPubkey ||
    vault.agentPubkey  !== params.agentPubkey  ||
    vault.vaultId      !== params.vaultId      ||
    vault.appDomain    !== params.appDomain
  ) {
    throw new Error("Vault parameter mismatch — wrong wallet, domain, vault, or agent");
  }

  // Verify AAD hash (tamper detection on stored metadata)
  const aad             = buildAAD(params);
  const expectedAadHash = await sha256Hex(aad);
  if (expectedAadHash !== vault.aadHash) {
    throw new Error("Vault AAD hash mismatch — metadata tampered");
  }

  const salt = hexToUint8(vault.salt);
  const key  = await deriveVaultKey(signature, salt, params);
  const iv   = hexToUint8(vault.iv);

  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await sub().decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      vault.ciphertext,
    );
  } catch {
    throw new Error("Vault decryption failed — wrong wallet or tampered ciphertext");
  }

  const envelope = JSON.parse(new TextDecoder().decode(plaintextBuf)) as {
    agentSecretKeyBase64: string;
    agentPubkey: string;
    walletPubkey: string;
    vaultId: string;
  };

  if (
    envelope.agentPubkey  !== params.agentPubkey  ||
    envelope.walletPubkey !== params.walletPubkey  ||
    envelope.vaultId      !== params.vaultId
  ) {
    throw new Error("Vault inner envelope mismatch — integrity error");
  }

  return base64ToUint8(envelope.agentSecretKeyBase64);
}

// ── Utilities (exported for chunks.ts and tests) ─────────────────────────────

export function generateVaultSalt(): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(32));
}

export function uint8ToHex(u: Uint8Array): string {
  return Array.from(u)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToUint8(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}

export function uint8ToBase64(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}

export function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
