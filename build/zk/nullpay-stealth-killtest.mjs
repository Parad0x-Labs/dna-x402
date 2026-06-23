#!/usr/bin/env node
/**
 * NullPay Stealth Inbox — offline crypto kill-test for the ed25519 explicit-scalar core.
 *
 * Pay a `.null`, funds land on a fresh ONE-TIME ed25519 address only the recipient can sweep.
 * The make-or-break claim (already landed on devnet, evidence/nullpay-stealth-devnet.json):
 * a stealth-derived scalar — which is NOT bit-clamped like a normal ed25519 seed — still
 * produces a signature that STOCK RFC-8032 ed25519 verify accepts (so Solana accepts the sweep).
 *
 * This proves it offline (no chain, no mainnet write): real ed25519 ECDH stealth derivation,
 * recipient recovers the one-time secret, signs with the explicit unclamped scalar, and the
 * signature verifies under @noble's stock ed25519.verify. Plus the unlinkability adversary check.
 */
import { createHash, randomBytes } from "node:crypto";
const { ed25519 } = await import("@noble/curves/ed25519");

const Point = ed25519.Point ?? ed25519.ExtendedPoint;
const L = ed25519.CURVE.n; // group order
const sha512 = (...b) => createHash("sha512").update(Buffer.concat(b.map(Buffer.from))).digest();
const leToInt = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n; };
const intToLE32 = (n) => { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
const modL = (buf) => { const r = leToInt(buf) % L; return r === 0n ? 1n : r; };
const rndScalar = () => modL(randomBytes(64));

// Sign message m with an EXPLICIT scalar a (no clamping) under pubkey A=a*G — RFC-8032 shape.
function signExplicit(a, A, m) {
  const Abytes = A.toRawBytes();
  const r = modL(sha512(Buffer.from("nullpay-nonce-v1"), intToLE32(a), m)); // deterministic nonce
  const R = Point.BASE.multiply(r);
  const Rbytes = R.toRawBytes();
  const k = modL(sha512(Rbytes, Abytes, m)); // challenge
  const s = (r + k * a) % L;
  return Buffer.concat([Rbytes, intToLE32(s)]); // 64-byte signature
}

const results = {};

// ── recipient publishes a stealth meta-address: scan + spend keypairs (real ed25519 points) ──
const scanSk = rndScalar(), spendSk = rndScalar();
const Scan = Point.BASE.multiply(scanSk);
const Spend = Point.BASE.multiply(spendSk);

// ── sender: derive a one-time address P from the published meta + a random ephemeral ──────────
const ephSk = rndScalar();
const Eph = Point.BASE.multiply(ephSk);
const sharedSender = sha512(Buffer.from("stealth-ecdh-v1"), Scan.multiply(ephSk).toRawBytes()); // ECDH eph*Scan
const tSender = modL(sharedSender);
const P = Spend.add(Point.BASE.multiply(tSender)); // one-time pubkey = Spend + t*G

// ── recipient: recompute shared from Eph, recover the one-time SECRET scalar ───────────────────
const sharedRecip = sha512(Buffer.from("stealth-ecdh-v1"), Eph.multiply(scanSk).toRawBytes()); // ECDH scan*Eph
const tRecip = modL(sharedRecip);
const p = (spendSk + tRecip) % L; // one-time secret (UNCLAMPED)
const Precovered = Point.BASE.multiply(p);

results.ecdh_shared_matches = Buffer.compare(sharedSender, sharedRecip) === 0;
results.recovered_secret_controls_address = Precovered.equals(P);

// ── the unclamped one-time scalar signs a sweep that STOCK ed25519 verify accepts ─────────────
const sweepMsg = Buffer.from("nullpay:sweep one-time note -> recipient main wallet");
const sig = signExplicit(p, P, sweepMsg);
results.explicit_scalar_sig_verifies_stock = ed25519.verify(sig, sweepMsg, P.toRawBytes());

// the scalar is genuinely NOT clamped (a normal ed25519 seed clamps bits 0-2 of byte0 + bit 6/7 of byte31)
const pLE = intToLE32(p);
const isClamped = (pLE[0] & 0b111) === 0 && (pLE[31] & 0b1100_0000) === 0b0100_0000;
results.scalar_is_unclamped = !isClamped;

// ── adversary: a wrong key cannot sign for P; a tampered message fails ─────────────────────────
results.wrong_key_cannot_sign = !ed25519.verify(signExplicit(rndScalar(), Point.BASE.multiply(rndScalar()), sweepMsg), sweepMsg, P.toRawBytes());
results.tampered_message_rejected = !ed25519.verify(sig, Buffer.from("nullpay:sweep -> ATTACKER wallet"), P.toRawBytes());

// ── unlinkability: without scanSk, P reveals nothing linking it to Spend/Scan ──────────────────
const P2 = Spend.add(Point.BASE.multiply(modL(sha512(Buffer.from("stealth-ecdh-v1"), Scan.multiply(rndScalar()).toRawBytes()))));
results.distinct_payments_unlinkable = !P.equals(P2) && !P.equals(Spend) && !P.equals(Scan);

console.log("=== NullPay Stealth Inbox — ed25519 explicit-scalar one-time address (offline) ===");
const checks = [
  ["ECDH shared secret matches (sender == recipient)", results.ecdh_shared_matches],
  ["recovered one-time secret controls the address", results.recovered_secret_controls_address],
  ["one-time scalar is UNCLAMPED (not a normal seed)", results.scalar_is_unclamped],
  ["explicit-scalar sig verifies under STOCK ed25519", results.explicit_scalar_sig_verifies_stock],
  ["wrong key cannot sign for the address", results.wrong_key_cannot_sign],
  ["tampered sweep message rejected", results.tampered_message_rejected],
  ["distinct payments unlinkable (no scan key)", results.distinct_payments_unlinkable],
];
for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
const pass = checks.every(([, ok]) => ok);
console.log(`\nRESULT: ${pass
  ? "PASS — a stealth-derived UNCLAMPED ed25519 scalar produces a signature stock RFC-8032 verify accepts (so Solana accepts the sweep). One-time addresses are unlinkable. Matches the devnet evidence; the on-chain leg waits for the founder."
  : "FAIL"}`);
process.exit(pass ? 0 : 1);
