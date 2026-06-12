/**
 * nullpay.ts — browser port of the NullPay ed25519 dual-key stealth client.
 *
 * Lifted from scripts/nullpay/nullpay-client.mjs (the same code the devnet e2e
 * uses). Byte-for-byte compatible with the Rust crate `dark-stealth-ed25519`:
 *   - same domain tags
 *   - same hash:  SHA512(tag || compressed_point) reduced mod L (64-byte wide)
 *   - same algebra: P = S + H(shared)*B,  p = (s + H(shared)) mod L
 *
 * The ONLY changes from the Node original are browser-safety:
 *   - Buffer.compare(...)  ->  bytesEqual(...)  (constant-length byte compare)
 *   - randomBytes(32)      ->  crypto.getRandomValues(new Uint8Array(32))
 * Everything else is pure @noble (curves + hashes) and runs unchanged in the DOM.
 *
 * Honest scope: this hides the RECIPIENT. The SENDER is still on-chain-linkable —
 * that is the shielded-pool / eNULL rail's job, not stealth addressing.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";

const Point = ed25519.Point;
const B = Point.BASE;
const L = Point.Fn.ORDER; // group order (2^252 + 27742...)

// Domain-separation tags — MUST match crates/dark-stealth-ed25519/src/lib.rs.
const TAG_VIEW = new TextEncoder().encode("nullpay-ed25519-view-key-v1");
const TAG_SHARED = new TextEncoder().encode("nullpay-ed25519-shared-v1");
const TAG_NONCE = new TextEncoder().encode("nullpay-ed25519-sign-nonce-v1");

// ── byte helpers (browser-safe; no Buffer) ────────────────────────────────────
const cat = (...a: Uint8Array[]): Uint8Array => {
  const t = a.reduce((n, x) => n + x.length, 0);
  const o = new Uint8Array(t);
  let i = 0;
  for (const x of a) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};

/** constant-length byte equality (replaces Node's Buffer.compare === 0). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 32 cryptographically-strong random bytes (replaces Node's randomBytes). */
export function randomSeed32(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

// ── scalar helpers ────────────────────────────────────────────────────────────
function scalarToLE(x: bigint): Uint8Array {
  const b = new Uint8Array(32);
  let v = ((x % L) + L) % L;
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}
function leToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}
// 64-byte little-endian -> scalar mod L (matches dalek from_bytes_mod_order_wide)
function reduceWide(h64: Uint8Array): bigint {
  return leToBig(h64) % L;
}
// 32-byte little-endian -> scalar mod L (matches dalek from_bytes_mod_order)
function reduce32(b32: Uint8Array): bigint {
  return leToBig(b32) % L;
}
function hashToScalarWide(tag: Uint8Array, msg: Uint8Array): bigint {
  return reduceWide(sha512(cat(tag, msg)));
}

export interface StealthKeys {
  spend: bigint;
  view: bigint;
  spendPub: Uint8Array;
  viewPub: Uint8Array;
  meta: Uint8Array; // 64 bytes: spend_pub || view_pub
}

export interface StealthPayment {
  stealthPub: Uint8Array; // 32B — the one-time address P
  ephemPub: Uint8Array; // 32B — the ephemeral R published in the announce
}

// ── deterministic key model — derive keys from the wallet itself ──────────────
//
// The recipient's stealth keys are derived from a signature their wallet makes
// over a FIXED message. ed25519 signatures are deterministic (RFC 8032 — the
// nonce comes from the key + message, no randomness), so the SAME wallet always
// reproduces the SAME signature, and therefore the SAME keys, on any device.
//
// This is the safety property: there is NO separate secret to back up or lose.
// Control of the wallet IS control of the funds — re-deriving from the wallet
// recovers every private payment ever sent to the name. Sweep destinations are
// always a wallet the user already controls, never a throwaway keypair.
export const NULLPAY_KEY_MESSAGE =
  "web0 · NullPay private inbox\n\n" +
  "Sign to derive your private-pay keys. This signature never leaves your device " +
  "and moves no funds. Anyone able to produce this signature with your wallet can " +
  "read and spend your private payments, so only sign on a wallet you control.\n\nv1";

const TAG_KEYSEED = new TextEncoder().encode("web0-nullpay-spend-seed-v1");

/** Derive deterministic stealth keys from a wallet's signature over
 *  NULLPAY_KEY_MESSAGE. Same wallet -> same signature -> same keys, every time,
 *  on every device. The signature is the only secret; it is the user's wallet. */
export function keysFromWalletSignature(signature: Uint8Array): StealthKeys {
  if (signature.length < 32) throw new Error("wallet signature too short to derive keys");
  const seed = sha512(cat(TAG_KEYSEED, signature)).slice(0, 32);
  return keygen(seed);
}

// ── keygen ────────────────────────────────────────────────────────────────────
// spendSeed: 32-byte Uint8Array. Returns { spend, view, spendPub, viewPub, meta(64B) }.
export function keygen(spendSeed: Uint8Array): StealthKeys {
  const spend = reduce32(spendSeed);
  if (spend === 0n) throw new Error("zero spend scalar");
  const view = hashToScalarWide(TAG_VIEW, scalarToLE(spend));
  if (view === 0n) throw new Error("zero view scalar");
  const S = B.multiply(spend);
  const V = B.multiply(view);
  const meta = cat(S.toBytes(), V.toBytes()); // 64 bytes: spend_pub || view_pub
  return { spend, view, spendPub: S.toBytes(), viewPub: V.toBytes(), meta };
}

// ── sender: derive a one-time stealth address ─────────────────────────────────
// meta64: 64-byte Uint8Array (spend_pub || view_pub). ephemSeed: 32 bytes.
export function derive(meta64: Uint8Array, ephemSeed: Uint8Array): StealthPayment {
  const r = reduce32(ephemSeed);
  if (r === 0n) throw new Error("zero ephemeral scalar");
  const S = Point.fromBytes(meta64.slice(0, 32));
  const V = Point.fromBytes(meta64.slice(32, 64));
  const R = B.multiply(r); // R = r*B
  const sharedPoint = V.multiply(r); // r*V = r*v*B
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const P = S.add(B.multiply(shared)); // P = S + shared*B
  return { stealthPub: P.toBytes(), ephemPub: R.toBytes() };
}

// ── recipient: scan (view key only) ───────────────────────────────────────────
export function scan(keys: StealthKeys, payment: StealthPayment): boolean {
  const R = Point.fromBytes(payment.ephemPub);
  const sharedPoint = R.multiply(keys.view); // v*R = v*r*B = r*V
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const S = Point.fromBytes(keys.spendPub);
  const candidate = S.add(B.multiply(shared)).toBytes();
  return bytesEqual(candidate, payment.stealthPub);
}

// ── recipient: recover one-time scalar p (spend key) ──────────────────────────
export function recover(
  keys: StealthKeys,
  payment: StealthPayment,
): { p: bigint; stealthPub: Uint8Array } {
  const R = Point.fromBytes(payment.ephemPub);
  const sharedPoint = R.multiply(keys.view);
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const p = (((keys.spend + shared) % L) + L) % L;
  if (p === 0n) throw new Error("zero stealth scalar");
  const pPub = B.multiply(p).toBytes();
  if (!bytesEqual(pPub, payment.stealthPub)) {
    throw new Error("recovered p does not match stealth pub (KeyMismatch)");
  }
  return { p, stealthPub: payment.stealthPub };
}

// ── recipient: from an announced R, derive the one-time address + its scalar ──
// Unlike scan(), this needs no prior knowledge of P — it COMPUTES the one-time
// address P = p·B for a given ephemeral R, so the inbox can then check P (and its
// token account) on-chain for funds and, if any, sweep them with the scalar p.
export function recipientOneTime(
  keys: StealthKeys,
  ephemPub: Uint8Array,
): { p: bigint; stealthPub: Uint8Array } {
  const R = Point.fromBytes(ephemPub);
  const sharedPoint = R.multiply(keys.view); // v·R = r·V
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const p = (((keys.spend + shared) % L) + L) % L;
  if (p === 0n) throw new Error("zero stealth scalar");
  return { p, stealthPub: B.multiply(p).toBytes() };
}

// ── raw-scalar EdDSA sign (RFC 8032 §5.1.6) with the one-time scalar p ─────────
// Produces a 64-byte R||S signature verifiable under P by stock ed25519 / Solana.
export function signWithStealthScalar(
  p: bigint,
  stealthPub: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  const pLE = scalarToLE(p);
  const prefix = sha512(cat(TAG_NONCE, pLE)); // 64-byte nonce prefix
  const r = reduceWide(sha512(cat(prefix, message))); // r = H(prefix || M) mod L
  const Rbytes = B.multiply(r).toBytes(); // R = r*B
  const k = reduceWide(sha512(cat(Rbytes, stealthPub, message))); // k = H(R||A||M)
  const s = (((r + k * p) % L) + L) % L; // S = (r + k*p) mod L
  return cat(Rbytes, scalarToLE(s));
}

export const consts = { L, TAG_VIEW, TAG_SHARED, TAG_NONCE };

// ── hex helper for displaying R / meta in the UI ──────────────────────────────
export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
