/**
 * null-miner-sdk — Chaumian NULL Mint: blind signature interface
 *
 * Chaumian blind signatures (Chaum 1982) let a user get a signature on a
 * message without the signer seeing the message. In the NULL Mint context:
 *
 *   User burns X USDC in the pool → wants an anonymous "receipt token"
 *   proving participation without revealing WHICH burn was theirs.
 *
 *   The mint issues a blind signature on the burn receipt hash.
 *   The user unblinds it → has a valid signature on "I burned X USDC"
 *   with no link back to their burn transaction.
 *
 * This is the GNU Taler model applied to DePIN payments.
 * The full implementation uses the dark-blind-signature Rust crate (on-chain).
 *
 * Scheme: Schnorr blind signature over secp256k1
 *   (matches the dark-blind-signature crate's group choice)
 *
 * Protocol:
 *   1. Mint: k ← Zq, R = k*G → send R to user
 *   2. User: α, β ← Zq
 *      R' = R + α*G + β*X  (X = mint pubkey)
 *      e  = H(R' || msg)
 *      c  = e - β          → send c to mint
 *   3. Mint: z = k - c*x   → send z to user
 *   4. User: z' = z + α    (unblind)
 *      Signature: (e, z')  on msg with public nonce R'
 *   5. Verify: H(z'*G + e*X || msg) == e?
 *      (z'*G + e*X = z*G + α*G + e*X = R - c*X + α*G + e*X = R + α*G + (e-c)*X = R' ✓)
 *
 * Devnet: the TypeScript layer runs the full Schnorr math.
 * Mainnet: replace with on-chain CPI to the dark-blind-signature program.
 */

import { secp256k1 }  from "@noble/curves/secp256k1";
import { sha256 }     from "@noble/hashes/sha256";
import { randomBytes } from "crypto";

// secp256k1 group order
const Q = secp256k1.CURVE.n;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mint's long-term key pair. */
export interface MintKeyPair {
  /** Private scalar x (32-byte BE hex). Keep secret. */
  privateKey: string;
  /** Compressed secp256k1 public key X = x*G (33 bytes, hex). Publish. */
  publicKey:  string;
}

/** One-time nonce published by the mint for a single signing session. */
export interface MintNonce {
  /** Public nonce R = k*G (33 bytes compressed, hex). */
  R: string;
  /** Session ID (prevents nonce reuse across sessions). */
  sessionId: string;
}

/** Client's blinded challenge — sent to the mint. */
export interface BlindedChallenge {
  /** Blinded challenge c = e - β (32-byte BE hex). */
  c: string;
  /** Blinded public nonce R' = R + α*G + β*X (33 bytes, hex). Keep private. */
  RPrime: string;
  /** Full challenge e = H(R' || msg) (32-byte hex). Keep private. */
  e: string;
}

/** Blinding state held by the client between blind() and unblind(). */
export interface BlindingState {
  alpha: bigint;
  beta:  bigint;
  RPrime: Uint8Array;
  e: bigint;
  message: Uint8Array;
}

/** Mint's blind signature response. */
export interface BlindSignatureResponse {
  /** z = k - c*x (32-byte BE hex). */
  z: string;
}

/** Unblinded Schnorr token. Verifiable without mint involvement. */
export interface UnblindedToken {
  /** Challenge e = H(R' || msg) (32-byte BE hex). */
  e: string;
  /** Unblinded response z' = z + α (32-byte BE hex). */
  zPrime: string;
  /** Blinded nonce R' (33-byte compressed public key, hex). */
  RPrime: string;
  /** The original message. */
  message: string;  // hex
}

// ── Mint Side ─────────────────────────────────────────────────────────────────

/** Generate a long-term mint key pair. */
export function mintKeyGen(): MintKeyPair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey  = secp256k1.getPublicKey(privateKey, true);
  return {
    privateKey: Buffer.from(privateKey).toString("hex"),
    publicKey:  Buffer.from(publicKey).toString("hex"),
  };
}

/**
 * Mint: generate a one-time signing nonce.
 * The nonce k (private) must be kept secret and NEVER reused.
 * Returns (k_hex, R_hex, sessionId) — store k, publish R + sessionId.
 */
export function mintSignInit(): {
  kPriv:     string;  // SECRET — do not publish
  nonce:     MintNonce;
} {
  const k          = randScalar();
  const R          = secp256k1.ProjectivePoint.BASE.multiply(k).toRawBytes(true);
  const sessionId  = Buffer.from(randomBytes(16)).toString("hex");
  return {
    kPriv: scalarToHex(k),
    nonce: { R: Buffer.from(R).toString("hex"), sessionId },
  };
}

/**
 * Mint: respond to a blinded challenge.
 * z = k - c*x mod q
 */
export function mintSign(
  kPrivHex:  string,
  xPrivHex:  string,
  blindedC:  string,
): BlindSignatureResponse {
  const k = hexToScalar(kPrivHex);
  const x = hexToScalar(xPrivHex);
  const c = hexToScalar(blindedC);
  const z = modQ(k - c * x);
  return { z: scalarToHex(z) };
}

// ── Client Side ───────────────────────────────────────────────────────────────

/**
 * Client: blind a message against the mint's nonce and public key.
 * Returns the blinded challenge (send to mint) and blinding state (keep secret).
 *
 * @param message      — 32-byte hash of the burn receipt (Uint8Array or hex)
 * @param mintPubHex   — mint's secp256k1 compressed public key (66-char hex)
 * @param mintNonceHex — mint's published nonce R (66-char hex)
 *
 * @example
 * const { challenge, state } = clientBlind(receiptHash, mint.publicKey, nonce.R);
 * // Send challenge.c to mint
 */
export function clientBlind(
  message:      Uint8Array | string,
  mintPubHex:   string,
  mintNonceHex: string,
): { challenge: BlindedChallenge; state: BlindingState } {
  const msg = typeof message === "string" ? Buffer.from(message, "hex") : message;
  const X   = secp256k1.ProjectivePoint.fromHex(mintPubHex);
  const R   = secp256k1.ProjectivePoint.fromHex(mintNonceHex);

  const alpha  = randScalar();
  const beta   = randScalar();

  // R' = R + α*G + β*X
  const alphaG  = secp256k1.ProjectivePoint.BASE.multiply(alpha);
  const betaX   = X.multiply(beta);
  const RPrime  = R.add(alphaG).add(betaX);
  const RPrimeBytes = RPrime.toRawBytes(true);

  // e = H(R'.x || msg)
  const e = hashChallenge(RPrimeBytes, msg);
  // c = e - β mod q
  const c = modQ(e - beta);

  return {
    challenge: {
      c:       scalarToHex(c),
      RPrime:  Buffer.from(RPrimeBytes).toString("hex"),
      e:       scalarToHex(e),
    },
    state: { alpha, beta, RPrime: RPrimeBytes, e, message: Uint8Array.from(msg) },
  };
}

/**
 * Client: unblind the mint's signature response.
 * z' = z + α mod q
 *
 * @example
 * const token = clientUnblind(mintResponse, state);
 * // token is now a valid blind signature on your message
 */
export function clientUnblind(
  response: BlindSignatureResponse,
  state:    BlindingState,
): UnblindedToken {
  const z      = hexToScalar(response.z);
  const zPrime = modQ(z + state.alpha);

  return {
    e:       scalarToHex(state.e),
    zPrime:  scalarToHex(zPrime),
    RPrime:  Buffer.from(state.RPrime).toString("hex"),
    message: Buffer.from(state.message).toString("hex"),
  };
}

/**
 * Verify an unblinded token against the mint's public key.
 *
 * Verification: H(z'*G + e*X || msg) == e?
 */
export function verifyNullToken(token: UnblindedToken, mintPubHex: string): boolean {
  try {
    const X      = secp256k1.ProjectivePoint.fromHex(mintPubHex);
    const e      = hexToScalar(token.e);
    const zP     = hexToScalar(token.zPrime);
    const msg    = Buffer.from(token.message, "hex");
    const RPrime = secp256k1.ProjectivePoint.fromHex(token.RPrime);

    // z'*G + e*X should equal R'
    const zPG  = secp256k1.ProjectivePoint.BASE.multiply(zP);
    const eX   = X.multiply(e);
    const check = zPG.add(eX);

    if (!check.equals(RPrime)) return false;

    // Recompute e = H(R' || msg) and check
    const eCheck = hashChallenge(RPrime.toRawBytes(true), msg);
    return eCheck === e;
  } catch {
    return false;
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

/** Random scalar in [1, q-1]. */
function randScalar(): bigint {
  const bytes = secp256k1.utils.randomPrivateKey();
  return hexToScalar(Buffer.from(bytes).toString("hex"));
}

/** secp256k1 modular reduction. */
function modQ(n: bigint): bigint {
  return ((n % Q) + Q) % Q;
}

/** Hash (R'.x_coord || msg) → challenge scalar. */
function hashChallenge(RPrime: Uint8Array, msg: Uint8Array): bigint {
  const data = Buffer.concat([RPrime, Buffer.from(msg)]);
  const h    = sha256(data);
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return modQ(n);
}

function hexToScalar(hex: string): bigint {
  const bytes = Buffer.from(hex.padStart(64, "0"), "hex");
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return modQ(n);
}

function scalarToHex(n: bigint): string {
  const v = modQ(n);
  const buf = Buffer.alloc(32);
  let tmp = v;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(tmp & 0xffn); tmp >>= 8n; }
  return buf.toString("hex");
}
