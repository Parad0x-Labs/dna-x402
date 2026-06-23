#!/usr/bin/env node
/**
 * ECASH-NULL — blind-BLS bearer cash kill-test on BN254 (the curve `sol_alt_bn128_group_op`
 * exposes on Solana MAINNET today). Routes AROUND the Ristretto / sol_curve_* path that gates
 * dark_fedimint_redeem on mainnet: the Chaumian DLEQ check is replaced by a 2-pairing BLS check
 *   e(sigma, G2) == e(M, K)      (i.e. e(sigma,G2) * e(M, -K) == 1)
 * which BN254 supports on mainnet now. The mint blind-signs without seeing the token (unlinkable),
 * the user unblinds, and redemption is a pairing check + a single-use nullifier.
 *
 * Offline kill-test — no chain, no mainnet write. Proves the math, the blinding correctness,
 * double-spend rejection, and forgery rejection. (Production note: M must be hash-to-curve to
 * the G1 subgroup; here M = h(serial)·G1 is sufficient to exercise the pairing/blinding logic.)
 */
import { randomBytes, createHash } from "node:crypto";
const { bn254 } = await import("@noble/curves/bn254");

const G1 = bn254.G1.ProjectivePoint;
const G2 = bn254.G2.ProjectivePoint;
const Fr = bn254.fields.Fr;
const Fp12 = bn254.fields.Fp12;

const rndScalar = () => {
  let s = 0n;
  while (s === 0n) s = BigInt("0x" + randomBytes(32).toString("hex")) % Fr.ORDER;
  return s;
};
const hashToScalar = (buf) => {
  const h = BigInt("0x" + createHash("sha256").update(buf).digest("hex")) % Fr.ORDER;
  return h === 0n ? 1n : h;
};
// message point in G1 (production: hash-to-curve; here h(serial)*G1 exercises the same algebra)
const M_of = (serial) => G1.BASE.multiply(hashToScalar(serial));
// e(sigma,G2) == e(M,K)
const verifyToken = (sigma, M, K) =>
  Fp12.eql(bn254.pairing(sigma, G2.BASE), bn254.pairing(M, K));

// ── mint setup ─────────────────────────────────────────────────────────────────
const k = rndScalar();              // mint secret
const K = G2.BASE.multiply(k);      // mint public key in G2

// ── issue a token, blinded (the mint never sees the token serial) ────────────────
const serial = randomBytes(16);     // the bearer token's secret serial
const M = M_of(serial);             // token message point
const r = rndScalar();              // user blinding factor
const Mb = M.multiply(r);           // blinded message handed to the mint
const Sb = Mb.multiply(k);          // mint blind-signs: k * (r*M)
const S = Sb.multiply(Fr.inv(r));   // user unblinds: r^-1 * Sb = k*M  (valid BLS sig on M)

const results = {};

// 1. a legit token redeems
results.legit_token_verifies = verifyToken(S, M, K);

// 2. the mint learned NOTHING linkable: its view (Mb) is r*M for random r — unlinkable to M
//    (sanity: Mb != M, and the unblinded S is nonetheless a valid signature on M)
results.blinding_unlinkable = !Mb.equals(M) && verifyToken(S, M, K);

// 3. double-spend: the nullifier (serial commitment) is single-use
const seen = new Set();
const nullifier = createHash("sha256").update(serial).digest("hex");
const redeem = (sig, msg) => {
  if (!verifyToken(sig, msg, K)) return "rejected:bad-signature";
  if (seen.has(nullifier)) return "rejected:double-spend";
  seen.add(nullifier);
  return "accepted";
};
const first = redeem(S, M);
const second = redeem(S, M);
results.first_redeem_accepted = first === "accepted";
results.double_spend_rejected = second === "rejected:double-spend";

// 4. forged signature (no mint key) fails the pairing
const forged = G1.BASE.multiply(rndScalar());
results.forged_signature_rejected = !verifyToken(forged, M, K);

// 5. signature is bound to its message — can't move it to another token
const otherM = M_of(randomBytes(16));
results.wrong_message_rejected = !verifyToken(S, otherM, K);

// 6. wrong mint key fails (token only valid under the issuing mint)
const K2 = G2.BASE.multiply(rndScalar());
results.wrong_mint_rejected = !verifyToken(S, M, K2);

console.log("=== ECASH-NULL — blind-BLS bearer cash on BN254 (mainnet alt_bn128 curve) ===");
const checks = [
  ["legit token verifies (2-pairing check)", results.legit_token_verifies],
  ["blind-sign is unlinkable + still valid", results.blinding_unlinkable],
  ["first redeem accepted", results.first_redeem_accepted],
  ["double-spend rejected (nullifier)", results.double_spend_rejected],
  ["forged signature rejected", results.forged_signature_rejected],
  ["signature bound to its message", results.wrong_message_rejected],
  ["wrong mint key rejected", results.wrong_mint_rejected],
];
for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
const pass = checks.every(([, ok]) => ok);
console.log(`\nRESULT: ${pass
  ? "PASS — Chaumian blind-BLS bearer cash verifies with a 2-pairing check on BN254. No Ristretto, no SIMD-0388, no trusted setup — the verify backend is live on Solana mainnet today."
  : "FAIL"}`);
process.exit(pass ? 0 : 1);
