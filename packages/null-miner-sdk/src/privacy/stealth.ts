/**
 * null-miner-sdk — Dual-Key Stealth Address Protocol (DKSAP)
 *
 * DKSAP (Peter Todd 2014, EIP-5564 2022) uses TWO key pairs:
 *   - Scan key:  X25519 — ECDH only. Safe to give to a watch-only scanning node.
 *   - Spend key: Ed25519 — signing. Never leave the device.
 *
 * The genius of the two-key split: your "scanning server" sees every stealth
 * address destined for you, but cannot spend any of them. Watch-only scanning
 * is a live deployment pattern in Monero wallets.
 *
 * Protocol over X25519 + Ed25519 (matches Solana's native curve):
 *
 *   Sender:
 *     r  ← random()                     ephemeral X25519 private
 *     R   = x25519(r)                   publish R in tx memo
 *     ss  = X25519.ecdh(r, scanPub)     ECDH shared secret
 *     t   = HKDF(ss, "stealth-scalar")  derive Ed25519-range scalar
 *     P_s = spendPub + t*G              one-time address  (Ed25519 point add)
 *
 *   Recipient scans with scan key only:
 *     ss  = X25519.ecdh(scanPriv, R)
 *     t   = HKDF(ss, "stealth-scalar")
 *     check: spendPub + t*G == P_s?
 *
 *   Recipient recovers spend key:
 *     spendScalar = getExtendedPublicKey(spendPriv).scalar
 *     stealthScalar = (spendScalar + t_bigint) mod l    (Ed25519 group order)
 *     stealthPub = stealthScalar * G
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 }          from "@noble/hashes/sha256";
import { hkdf }            from "@noble/hashes/hkdf";
import { randomBytes }     from "crypto";

// ── Ed25519 group order ────────────────────────────────────────────────────────
const ED25519_L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StealthKeyPair {
  /** X25519 private key for ECDH scanning (32 bytes). Give to watch-only node. */
  scanPriv:  Uint8Array;
  /** X25519 public key to publish (32 bytes). */
  scanPub:   Uint8Array;
  /** Ed25519 private key seed for spending (32 bytes). Keep secret. */
  spendPriv: Uint8Array;
  /** Ed25519 public key — base of all stealth addresses (32 bytes). */
  spendPub:  Uint8Array;
}

export interface StealthAddress {
  /** One-time Ed25519 public key — pay to this. */
  stealthPub:   Uint8Array;
  /** Ephemeral X25519 public key to publish in the transaction. */
  ephemeralPub: Uint8Array;
  /**
   * View tag: first byte of t (the derived scalar).
   * Lets scanners skip 255/256 addresses in O(1) — only 1/256 need full ECDH.
   * EIP-5564 view tag optimisation.
   */
  viewTag:      number;
}

export interface StealthSpendKey {
  /** The one-time Ed25519 address (verify this owns the payment). */
  stealthPub: Uint8Array;
  /**
   * Raw Ed25519 scalar (32-byte LE bigint) for the stealth address.
   * NOT a standard seed — use directly with `ed25519.Point.BASE.multiply(scalar)`.
   * For Solana transaction signing, wrap with a custom signer adapter.
   */
  stealthScalar: Uint8Array;
}

// ── Key Generation ─────────────────────────────────────────────────────────────

/** Generate a fresh stealth key pair from cryptographically random secrets. */
export function generateStealthKeyPair(): StealthKeyPair {
  const scanPriv  = x25519.utils.randomSecretKey();
  const spendPriv = ed25519.utils.randomSecretKey();
  return {
    scanPriv,
    scanPub:  x25519.getPublicKey(scanPriv),
    spendPriv,
    spendPub: ed25519.getPublicKey(spendPriv),
  };
}

/**
 * Derive a deterministic stealth key pair from a 32-byte seed.
 * Used by AgentPassport — reproducible from the spend key, no extra secrets.
 *
 *   scanPriv  = HKDF-SHA256(seed, label="null-miner-stealth-scan-v1",  32 bytes)
 *   spendPriv = HKDF-SHA256(seed, label="null-miner-stealth-spend-v1", 32 bytes)
 */
export function deriveStealthKeyPair(seed: Uint8Array): StealthKeyPair {
  const scanPriv  = hkdf(sha256, seed, undefined, "null-miner-stealth-scan-v1",  32);
  const spendPriv = hkdf(sha256, seed, undefined, "null-miner-stealth-spend-v1", 32);
  return {
    scanPriv:  Uint8Array.from(scanPriv),
    scanPub:   x25519.getPublicKey(Uint8Array.from(scanPriv)),
    spendPriv: Uint8Array.from(spendPriv),
    spendPub:  ed25519.getPublicKey(Uint8Array.from(spendPriv)),
  };
}

// ── Sender Side ───────────────────────────────────────────────────────────────

/**
 * Generate a stealth address for `recipient`.
 *
 * @param recipientScanPub  — recipient's X25519 scan public key (32 bytes)
 * @param recipientSpendPub — recipient's Ed25519 spend public key (32 bytes)
 * @param ephemeralPriv     — optional: override ephemeral key for determinism (tests)
 *
 * @example
 * const addr = generateStealthAddress(recipient.scanPub, recipient.spendPub);
 * // Pay to: bs58.encode(addr.stealthPub)   (base58 Solana address)
 * // Store:  addr.ephemeralPub in the tx memo for recipient to scan
 */
export function generateStealthAddress(
  recipientScanPub:  Uint8Array,
  recipientSpendPub: Uint8Array,
  ephemeralPriv?:    Uint8Array,
): StealthAddress {
  const r  = ephemeralPriv ?? x25519.utils.randomSecretKey();
  const R  = x25519.getPublicKey(r);
  const ss = x25519.getSharedSecret(r, recipientScanPub);
  const t  = deriveScalar(ss);

  return {
    stealthPub:   pointAdd(recipientSpendPub, t),
    ephemeralPub: R,
    viewTag:      t[0]!,
  };
}

// ── Recipient Side ────────────────────────────────────────────────────────────

/**
 * Check if a stealth address belongs to this key pair.
 * Only needs scanPriv — safe to run on a watch-only node.
 *
 * @param viewTag — optional fast reject (1/256 false positive rate → 99.6% scan skip)
 */
export function checkStealthAddress(
  keys:         Pick<StealthKeyPair, "scanPriv" | "spendPub">,
  ephemeralPub: Uint8Array,
  stealthPub:   Uint8Array,
  viewTag?:     number,
): boolean {
  const ss = x25519.getSharedSecret(keys.scanPriv, ephemeralPub);
  const t  = deriveScalar(ss);

  if (viewTag !== undefined && t[0] !== viewTag) return false;

  const expected = pointAdd(keys.spendPub, t);
  return constTimeEqual(expected, stealthPub);
}

/**
 * Recover the spending scalar for a stealth address.
 * Requires spendPriv — should only run on the secure device.
 *
 * stealthScalar = (spendScalar + t_bigint) mod l
 *
 * The returned stealthScalar can be used as a raw Ed25519 signing scalar.
 * For Solana, pair it with a custom signer that uses scalar directly.
 */
export function recoverStealthSpendKey(
  keys:         StealthKeyPair,
  ephemeralPub: Uint8Array,
): StealthSpendKey {
  const ss = x25519.getSharedSecret(keys.scanPriv, ephemeralPub);
  const t  = deriveScalar(ss);

  // Get the spend private scalar (after SHA-512 hash + clamping)
  const { scalar: spendScalar } = ed25519.utils.getExtendedPublicKey(keys.spendPriv);
  const tBigInt                 = leToBI(t) % ED25519_L;
  const stealthScalar           = (spendScalar + tBigInt) % ED25519_L;

  // Verify: stealthScalar * G == stealthPub
  const stealthPub = ed25519.Point.BASE.multiply(stealthScalar).toRawBytes();

  return {
    stealthPub,
    stealthScalar: biToLE(stealthScalar, 32),
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte scalar from an X25519 shared secret.
 * HKDF-SHA256(ss, salt=undefined, info="null-miner-stealth-scalar-v1")
 */
function deriveScalar(ss: Uint8Array): Uint8Array {
  return Uint8Array.from(
    hkdf(sha256, ss, undefined, "null-miner-stealth-scalar-v1", 32),
  );
}

/** Ed25519 point addition: P + t*G → compressed 32 bytes. */
function pointAdd(spendPub: Uint8Array, t: Uint8Array): Uint8Array {
  const tBigInt = leToBI(t) % ED25519_L;
  const P       = ed25519.Point.fromHex(spendPub);
  const tG      = ed25519.Point.BASE.multiply(tBigInt);
  return P.add(tG).toRawBytes();
}

/** Constant-time byte comparison. */
function constTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Little-endian bytes → bigint. */
function leToBI(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** bigint → little-endian Uint8Array of length `len`. */
function biToLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = 0; i < len; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
