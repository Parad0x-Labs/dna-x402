/**
 * NullPay client — ed25519 dual-key stealth addressing in JS.
 *
 * Byte-for-byte compatible with the Rust crate `dark-stealth-ed25519`:
 *   - same domain tags
 *   - same hash:  SHA512(tag || compressed_point) reduced mod L (64-byte wide)
 *   - same algebra: P = S + H(shared)*B,  p = (s + H(shared)) mod L
 *
 * The one-time stealth address P is a NATIVE Solana ed25519 pubkey; the recipient
 * signs the sweep tx with the one-time scalar p using raw-scalar EdDSA (RFC 8032),
 * which Solana's runtime / tweetnacl verify with stock ed25519. No ZK, no setup.
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

// ── scalar helpers ──────────────────────────────────────────────────────────
const cat = (...a) => { const t = a.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
function scalarToLE(x) { const b = new Uint8Array(32); let v = ((x % L) + L) % L; for (let i = 0; i < 32; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; }
function leToBig(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
// 64-byte little-endian -> scalar mod L (matches dalek from_bytes_mod_order_wide)
function reduceWide(h64) { return leToBig(h64) % L; }
// 32-byte little-endian -> scalar mod L (matches dalek from_bytes_mod_order)
function reduce32(b32) { return leToBig(b32) % L; }

function hashToScalarWide(tag, msg) { return reduceWide(sha512(cat(tag, msg))); }

// ── keygen ──────────────────────────────────────────────────────────────────
// spendSeed: 32-byte Uint8Array. Returns { spend, view, S, V, meta(64B) }.
export function keygen(spendSeed) {
  const spend = reduce32(spendSeed);
  if (spend === 0n) throw new Error("zero spend scalar");
  const view = hashToScalarWide(TAG_VIEW, scalarToLE(spend));
  if (view === 0n) throw new Error("zero view scalar");
  const S = B.multiply(spend);
  const V = B.multiply(view);
  const meta = cat(S.toBytes(), V.toBytes()); // 64 bytes: spend_pub || view_pub
  return {
    spend, view,
    spendPub: S.toBytes(), viewPub: V.toBytes(),
    meta,
  };
}

// ── sender: derive a one-time stealth address ─────────────────────────────────
// meta64: 64-byte Uint8Array (spend_pub || view_pub). ephemSeed: 32 bytes.
// Returns { stealthPub(32B), ephemPub(32B) }.
export function derive(meta64, ephemSeed) {
  const r = reduce32(ephemSeed);
  if (r === 0n) throw new Error("zero ephemeral scalar");
  const S = Point.fromBytes(meta64.slice(0, 32));
  const V = Point.fromBytes(meta64.slice(32, 64));
  const R = B.multiply(r);                 // R = r*B
  const sharedPoint = V.multiply(r);       // r*V = r*v*B
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const P = S.add(B.multiply(shared));     // P = S + shared*B
  return { stealthPub: P.toBytes(), ephemPub: R.toBytes() };
}

// ── recipient: scan (view key only) ──────────────────────────────────────────
// keys: from keygen(). payment: { stealthPub, ephemPub }. Returns bool match.
export function scan(keys, payment) {
  const R = Point.fromBytes(payment.ephemPub);
  const sharedPoint = R.multiply(keys.view); // v*R = v*r*B = r*V
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const S = Point.fromBytes(keys.spendPub);
  const candidate = S.add(B.multiply(shared)).toBytes();
  return Buffer.compare(Buffer.from(candidate), Buffer.from(payment.stealthPub)) === 0;
}

// ── recipient: recover one-time scalar p (spend key) ──────────────────────────
// Returns { p (bigint), stealthPub(32B) }. Asserts p*B == P.
export function recover(keys, payment) {
  const R = Point.fromBytes(payment.ephemPub);
  const sharedPoint = R.multiply(keys.view);
  const shared = hashToScalarWide(TAG_SHARED, sharedPoint.toBytes());
  const p = ((keys.spend + shared) % L + L) % L;
  if (p === 0n) throw new Error("zero stealth scalar");
  const pPub = B.multiply(p).toBytes();
  if (Buffer.compare(Buffer.from(pPub), Buffer.from(payment.stealthPub)) !== 0) {
    throw new Error("recovered p does not match stealth pub (KeyMismatch)");
  }
  return { p, stealthPub: payment.stealthPub };
}

// ── raw-scalar EdDSA sign (RFC 8032 §5.1.6) with the one-time scalar p ─────────
// Produces a 64-byte R||S signature verifiable under P by stock ed25519 / tweetnacl.
// matches crates/dark-stealth-ed25519::sign.
export function signWithStealthScalar(p, stealthPub, message) {
  const pLE = scalarToLE(p);
  const prefix = sha512(cat(TAG_NONCE, pLE));            // 64-byte nonce prefix
  const r = reduceWide(sha512(cat(prefix, message)));    // r = H(prefix || M) mod L
  const Rbytes = B.multiply(r).toBytes();                // R = r*B
  const k = reduceWide(sha512(cat(Rbytes, stealthPub, message))); // k = H(R||A||M) mod L
  const s = ((r + k * p) % L + L) % L;                   // S = (r + k*p) mod L
  return cat(Rbytes, scalarToLE(s));
}

export const consts = { L, TAG_VIEW, TAG_SHARED, TAG_NONCE };
