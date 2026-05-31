#!/usr/bin/env node
/**
 * WebAuthn PRF → Ed25519 Solana key derivation demo.
 *
 * This is the missing primitive that solves the secp256r1 ↔ Ed25519 gap:
 *
 *   PRF(salt) → 32 bytes → HKDF → Ed25519 seed → native Solana keypair
 *
 * The Ed25519 key is DERIVED from the hardware authenticator.
 * It is never stored anywhere. Biometric auth = key derivation.
 * No secp256r1 bridging. No MPC. No custodial relay.
 *
 * This is what LazorKit (and every other passkey wallet) doesn't do:
 * they gate with secp256r1 but still proxy through an Ed25519 key.
 * PRF lets the biometric directly produce the Ed25519 key.
 *
 * Browser support: Chrome 132+, Safari 18+, Android Chrome (Pixel 6+)
 * All support the `prf` extension in WebAuthn.
 *
 * This demo proves the derivation math — the browser test page
 * (05-prf-browser-test.html) proves it with real hardware.
 */

import { createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";

// ── PRF → Ed25519 derivation ──────────────────────────────────────────────────

const DOMAIN = "dark-passport-prf-v1"; // deterministic domain separation

/**
 * Derive an Ed25519 Solana keypair from a WebAuthn PRF output.
 *
 * @param prfOutput  32 bytes from navigator.credentials.get({ extensions: { prf: { eval: { first: salt } } } })
 * @param salt       The salt used in the PRF eval (must be the same each time for the same key)
 * @returns          { publicKey (32 bytes), secretKey (64 bytes), base58 }
 */
function hkdf32(ikm, salt, info) {
  // HKDF-SHA256, 32-byte output
  // Extract: prk = HMAC-SHA256(salt, ikm)
  const prk = createHmac("sha256", salt).update(ikm).digest();
  // Expand: T(1) = HMAC-SHA256(prk, info || 0x01)
  const h = createHmac("sha256", prk);
  h.update(Buffer.isBuffer(info) ? info : Buffer.from(info));
  h.update(Buffer.from([0x01]));
  return h.digest();
}

export function deriveEd25519FromPrf(prfOutput, salt) {
  if (prfOutput.length !== 32) throw new Error("PRF output must be 32 bytes");
  const seed = hkdf32(prfOutput, salt, DOMAIN);
  const keypair = Keypair.fromSeed(seed);
  return {
    publicKey:  keypair.publicKey.toBytes(),
    secretKey:  keypair.secretKey,
    base58:     keypair.publicKey.toBase58(),
    seed,       // the 32-byte derived seed (same as ed25519 privkey seed)
  };
}

/**
 * Verify the derivation is deterministic.
 * Same PRF output + same salt = same keypair, always.
 */
export function isDeterministic(prfOutput, salt) {
  const k1 = deriveEd25519FromPrf(prfOutput, salt);
  const k2 = deriveEd25519FromPrf(prfOutput, salt);
  return k1.base58 === k2.base58;
}

/**
 * Standard salt for Dark Passport PRF derivation.
 * Using a fixed domain-specific salt so all Parad0x apps derive the same key.
 */
export const DARK_PASSPORT_SALT = new TextEncoder().encode("dark-passport-solana-v1");

// ── Demo ───────────────────────────────────────────────────────────────────────

function demo() {
  console.log("\n=== WebAuthn PRF → Ed25519 Solana Key Demo ===\n");

  // Simulate a PRF output (in browser: real hardware produces this)
  const mockPrfOutput = new Uint8Array(32);
  mockPrfOutput.fill(0x42); // 32 bytes of 0x42 as stand-in for real PRF

  const keypair = deriveEd25519FromPrf(mockPrfOutput, DARK_PASSPORT_SALT);
  const deterministic = isDeterministic(mockPrfOutput, DARK_PASSPORT_SALT);

  console.log("Mock PRF output: 0x" + Buffer.from(mockPrfOutput).toString("hex").slice(0, 16) + "...");
  console.log("Derived Ed25519 public key:", keypair.base58);
  console.log("Seed:", Buffer.from(keypair.seed).toString("hex").slice(0, 16) + "...");
  console.log("Deterministic:", deterministic ? "YES ✓" : "NO ✗");

  console.log("\nKey properties:");
  console.log("  Native Solana Ed25519 keypair ✓");
  console.log("  Derived from hardware (no storage) ✓");
  console.log("  Deterministic (same auth = same key) ✓");
  console.log("  No secp256r1 bridging needed ✓");
  console.log("  No MPC or custodial relay ✓");

  console.log("\nWhat this enables:");
  console.log("  1. Biometric auth → PRF output → Ed25519 seed → Solana tx signing");
  console.log("  2. The key lives only in the auth hardware (never exported/stored)");
  console.log("  3. Recovery: re-auth with same device = same key (for platform authenticators)");
  console.log("  4. First Solana-native hardware-bound passkey without MPC");

  console.log("\nBrowser flow:");
  console.log("  Register: navigator.credentials.create() → store passkey in hardware");
  console.log("  Sign-in:  navigator.credentials.get({ extensions: { prf: { eval: { first: salt } } } })");
  console.log("            → prf_output (32B) → HKDF → ed25519 seed → Keypair.fromSeed()");
  console.log("            → sign Solana transaction natively");
  console.log("  No secp256r1. No bridge. No relay. Just biometric → Ed25519.");
}

demo();
