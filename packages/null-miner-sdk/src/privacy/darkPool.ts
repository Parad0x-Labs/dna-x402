/**
 * null-miner-sdk — Dark Pool: ECDH task encryption
 *
 * Encrypted task marketplace: a platform can post tasks with encrypted details
 * visible only to agents with the decryption key. Agents prove completion via
 * ZK receipt without revealing which encrypted task they solved.
 *
 * Protocol:
 *   1. Platform generates an ephemeral X25519 key pair per task batch
 *   2. Platform encrypts each task with: AES-256-GCM(AES_key, task_json)
 *      where AES_key = HKDF(X25519.ecdh(platformPriv, agentScanPub))
 *   3. Platform publishes: ephemeralPub + encryptedTask
 *   4. Agent decrypts: AES_key = HKDF(X25519.ecdh(agentScanPriv, platformPub))
 *
 * The "dark" part: a passive observer sees only encrypted task blobs.
 * The agent's scan key can be watch-only — all decryption is local.
 * Sealed bids (agent submits encrypted proof before reveal) use the same key.
 */

import { x25519 }      from "@noble/curves/ed25519";
import { sha256 }      from "@noble/hashes/sha256";
import { hkdf }        from "@noble/hashes/hkdf";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

/** An ECDH-encrypted task payload. */
export interface EncryptedTask {
  /** Sender's ephemeral X25519 public key (32 bytes, hex). */
  ephemeralPub: string;
  /** AES-256-GCM nonce (12 bytes, hex). */
  nonce: string;
  /** Authentication tag (16 bytes, hex). */
  tag: string;
  /** Ciphertext (hex). */
  ciphertext: string;
}

/** A sealed bid — agent commits to a proof before task reveal. */
export interface SealedBid {
  /** Bidder's ephemeral X25519 public key (32 bytes, hex). */
  bidderEphemeralPub: string;
  /** Encrypted proof hash (the commitment). */
  encryptedBid: string;
  nonce: string;
  tag:   string;
  /** Timestamp for bid ordering. */
  timestamp: number;
}

// ── Encryption ────────────────────────────────────────────────────────────────

/**
 * Encrypt a task payload for a specific agent (their scan public key).
 *
 * @param taskJson        — task details as a JSON-serialisable object
 * @param recipientScanPub — agent's X25519 scan public key (32-byte Uint8Array)
 * @param senderPriv       — optional: override ephemeral key for determinism (tests)
 *
 * @example
 * const { encrypted, senderPub } = encryptTask(taskSpec, agent.scanPub);
 * // Publish: { ...encrypted, for: agent.passportId }
 */
export function encryptTask(
  taskJson:          unknown,
  recipientScanPub:  Uint8Array,
  senderPriv?:       Uint8Array,
): { encrypted: EncryptedTask; senderPub: Uint8Array } {
  const r   = senderPriv ?? x25519.utils.randomSecretKey();
  const R   = x25519.getPublicKey(r);
  const ss  = x25519.getSharedSecret(r, recipientScanPub);
  const key = deriveAesKey(ss, R, "task");

  const nonce      = randomBytes(12);
  const plaintext  = Buffer.from(JSON.stringify(taskJson), "utf8");
  const cipher     = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag        = (cipher as unknown as { getAuthTag(): Uint8Array }).getAuthTag();

  return {
    senderPub: R,
    encrypted: {
      ephemeralPub: Buffer.from(R).toString("hex"),
      nonce:        nonce.toString("hex"),
      tag:          Buffer.from(tag).toString("hex"),
      ciphertext:   ciphertext.toString("hex"),
    },
  };
}

/**
 * Decrypt a task payload using the agent's scan private key.
 *
 * @example
 * const task = decryptTask(encrypted, agentScanPriv);
 */
export function decryptTask<T = unknown>(
  encrypted:      EncryptedTask,
  recipientScanPriv: Uint8Array,
): T {
  const R   = Buffer.from(encrypted.ephemeralPub, "hex");
  const ss  = x25519.getSharedSecret(recipientScanPriv, R);
  const key = deriveAesKey(ss, R, "task");

  const nonce      = Buffer.from(encrypted.nonce, "hex");
  const tag        = Buffer.from(encrypted.tag,   "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  (decipher as unknown as { setAuthTag(tag: Uint8Array): void }).setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

// ── Sealed Bids ───────────────────────────────────────────────────────────────

/**
 * Create a sealed bid — commit to a proof before the task is revealed.
 * The bid contains an encrypted proof hash; only the task poster can open it.
 *
 * @param proofHash        — the proof hash being committed (64-char hex)
 * @param platformScanPub  — platform's X25519 public key (they'll open bids)
 *
 * @example
 * const bid = sealBid(proofHash, platform.scanPub);
 * // Submit bid to marketplace; platform opens after deadline
 */
export function sealBid(
  proofHash:        string,
  platformScanPub:  Uint8Array,
): SealedBid {
  const r  = x25519.utils.randomSecretKey();
  const R  = x25519.getPublicKey(r);
  const ss = x25519.getSharedSecret(r, platformScanPub);
  const key = deriveAesKey(ss, R, "bid");

  const nonce      = randomBytes(12);
  const plaintext  = Buffer.from(proofHash, "utf8");
  const cipher     = createCipheriv("aes-256-gcm", key, nonce);
  const encBid     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag        = (cipher as unknown as { getAuthTag(): Uint8Array }).getAuthTag();

  return {
    bidderEphemeralPub: Buffer.from(R).toString("hex"),
    encryptedBid:       encBid.toString("hex"),
    nonce:              nonce.toString("hex"),
    tag:                Buffer.from(tag).toString("hex"),
    timestamp:          Date.now(),
  };
}

/**
 * Open a sealed bid using the platform's scan private key.
 *
 * @returns the proof hash the agent committed to
 */
export function openBid(
  bid:                SealedBid,
  platformScanPriv:   Uint8Array,
): string {
  const R   = Buffer.from(bid.bidderEphemeralPub, "hex");
  const ss  = x25519.getSharedSecret(platformScanPriv, R);
  const key = deriveAesKey(ss, R, "bid");

  const nonce      = Buffer.from(bid.nonce, "hex");
  const tag        = Buffer.from(bid.tag,   "hex");
  const ciphertext = Buffer.from(bid.encryptedBid, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  (decipher as unknown as { setAuthTag(tag: Uint8Array): void }).setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// ── Internal ──────────────────────────────────────────────────────────────────

/** Derive 32-byte AES-256 key from X25519 shared secret + ephemeral pub. */
function deriveAesKey(ss: Uint8Array, R: Uint8Array, purpose: string): Uint8Array {
  const salt = R;  // ephemeral pub as salt — unique per session
  const info = `null-miner-dark-pool-${purpose}-v1`;
  return Uint8Array.from(hkdf(sha256, ss, salt, info, 32));
}
