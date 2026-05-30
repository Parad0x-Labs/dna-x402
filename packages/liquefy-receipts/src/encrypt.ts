/**
 * AES-256-GCM encryption for compressed receipt batches.
 *
 * Uses WebCrypto (browser + Node 22 identical API).
 * Only the payer and payee derive the shared key (ECDH over their Solana keys
 * is Phase 2 — for now the key is caller-supplied so callers can use any KDF
 * they want: ECDH, HKDF, passphrase, etc.).
 *
 * Output: [nonce(12)] [ciphertext + tag(N+16)]
 */

const subtle = (globalThis.crypto ?? (await import("node:crypto")).webcrypto).subtle;

export interface EncryptedBlob {
  nonce:      Uint8Array; // 12 bytes
  ciphertext: Uint8Array; // plaintext.length + 16 (GCM tag)
}

/** Import a raw 32-byte AES-256-GCM key. */
export async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Generate a fresh random 32-byte key. */
export async function generateKey(): Promise<Uint8Array> {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  return new Uint8Array(await subtle.exportKey("raw", key));
}

/** Encrypt a Uint8Array. Returns nonce + ciphertext. */
export async function encryptBlob(plaintext: Uint8Array, key: CryptoKey): Promise<EncryptedBlob> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext)
  );
  return { nonce, ciphertext };
}

/** Decrypt a blob. */
export async function decryptBlob(blob: EncryptedBlob, key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: blob.nonce }, key, blob.ciphertext)
  );
}

/** Serialise nonce+ciphertext into a single Uint8Array for on-chain anchoring. */
export function serializeBlob(blob: EncryptedBlob): Uint8Array {
  const out = new Uint8Array(12 + blob.ciphertext.length);
  out.set(blob.nonce, 0);
  out.set(blob.ciphertext, 12);
  return out;
}

/** Deserialise a Uint8Array back into nonce+ciphertext. */
export function deserializeBlob(data: Uint8Array): EncryptedBlob {
  return { nonce: data.slice(0, 12), ciphertext: data.slice(12) };
}
