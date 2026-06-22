#!/usr/bin/env node
/**
 * Held-out adversarial benchmark — shielded_withdraw_v3 hardening (circuit layer).
 *
 * Differential: compile the VULN circuit (git HEAD) AND the FIXED circuit, then prove the
 * FIXED circuit closes the two soundness holes the audit found while staying functional:
 *
 *   L   legit withdraw             -> VERIFIES on FIXED (and on VULN: apples-to-apples)
 *   A1  nullifier malleability     -> VULN: two DISTINCT valid nullifiers for ONE note in ONE
 *                                     pool (a free `pool_key_field` witness) = unlimited
 *                                     double-spend. FIXED: nullifier is forced to
 *                                     Poseidon(2,secret,pool_id) — a non-canonical nullifier is
 *                                     UNSAT, and the canonical one is deterministic so the
 *                                     on-chain nullifier-uniqueness check blocks the replay.
 *   A2  non-boolean path selector  -> VULN: a path_index=2 "membership" proof is ACCEPTED
 *                                     (MultiMux1 only blends, never selects). FIXED: the
 *                                     s*(s-1)===0 constraint makes a non-boolean selector UNSAT.
 *
 * Grade PASS iff: L verifies on FIXED; AND each attack is PRESENT on VULN (so the benchmark
 * genuinely detects it) and CLOSED on FIXED. No chain — pure math layer (snarkjs
 * fullprove/verify). poseidon-lite == circomlib == on-chain sol_poseidon, so the off-circuit
 * tree can't drift from the real one (the L case is itself the cross-check).
 *
 * Env: ART_FIXED, ART_VULN — dirs each holding shielded_withdraw_v3{.wasm,_final.zkey,_vk.json}.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const ART_FIXED = process.env.ART_FIXED ?? "/work/art/fixed";
const ART_VULN  = process.env.ART_VULN  ?? "/work/art/vuln";
const NAME = "shielded_withdraw_v3";
const SNARKJS = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");
const { poseidon2, poseidon3 } = await import("poseidon-lite");

const DEPTH = 20;
const DOMAIN_COMMIT = 1n, DOMAIN_NULLIF = 2n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const mod = (x) => ((x % P) + P) % P;
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;

function fullprove(artDir, input) {
  const tmp = mkdtempSync(join(tmpdir(), "swv3-"));
  const inP = join(tmp, "in.json"), pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(inP, JSON.stringify(input));
  try {
    execFileSync(process.execPath,
      [SNARKJS, "groth16", "fullprove", inP, join(artDir, `${NAME}.wasm`), join(artDir, `${NAME}_final.zkey`), pfP, pubP],
      { stdio: "pipe" });
    const proof = JSON.parse(readFileSync(pfP, "utf8")), pub = JSON.parse(readFileSync(pubP, "utf8"));
    rmSync(tmp, { recursive: true, force: true });
    return { ok: true, proof, pub };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: (e.stderr?.toString() || e.message || "").split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 160) };
  }
}

function verify(artDir, proof, pub) {
  const tmp = mkdtempSync(join(tmpdir(), "vrf-"));
  const pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(pfP, JSON.stringify(proof)); writeFileSync(pubP, JSON.stringify(pub));
  try {
    const out = execFileSync(process.execPath, [SNARKJS, "groth16", "verify", join(artDir, `${NAME}_vk.json`), pubP, pfP], { stdio: "pipe" }).toString();
    rmSync(tmp, { recursive: true, force: true });
    return /OK/.test(out);
  } catch { rmSync(tmp, { recursive: true, force: true }); return false; }
}

// ── empty depth-20 Poseidon tree: zero-subtree roots ────────────────────────────
const zeros = [0n];
for (let i = 1; i <= DEPTH; i++) zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));

// ── one real note at leaf_index 0 (siblings = empty-subtree roots, all left) ─────
const secret = randFr();
const leafIndex = 0n;
const commitment = poseidon3([DOMAIN_COMMIT, secret, leafIndex]);
const pathElements = zeros.slice(0, DEPTH);
const pathIndexZero = new Array(DEPTH).fill("0");
let h = commitment;
for (let i = 0; i < DEPTH; i++) h = poseidon2([h, pathElements[i]]); // leaf always on the left
const merkleRoot = h;

const pool_id = randFr(), recipient = randFr(), relayer = randFr();
const denomination = 100000000n, fee = 1000000n, payout = denomination - fee;
const canonicalNullifier = poseidon3([DOMAIN_NULLIF, secret, pool_id]);

function baseInput(variant, over = {}) {
  const inp = {
    nullifier: String(canonicalNullifier),
    merkle_root: String(merkleRoot),
    recipient: String(recipient),
    pool_id: String(pool_id),
    relayer: String(relayer),
    fee: String(fee),
    denomination: String(denomination),
    secret: String(secret),
    leaf_index: String(leafIndex),
    path_elements: pathElements.map(String),
    path_index: pathIndexZero.slice(),
    payout_recipient: String(payout),
  };
  if (variant === "vuln") inp.pool_key_field = String(pool_id); // legit: pool_key_field == pool_id
  return Object.assign(inp, over);
}

// blended root from a non-boolean selector at level 0 (emulates MultiMux1's linear blend)
function blendRoot(s0) {
  let hh = commitment;
  const c00 = hh, c01 = pathElements[0], c10 = pathElements[0], c11 = hh;
  const out0 = mod((c01 - c00) * s0 + c00);
  const out1 = mod((c11 - c10) * s0 + c10);
  hh = poseidon2([out0, out1]);
  for (let i = 1; i < DEPTH; i++) hh = poseidon2([hh, pathElements[i]]);
  return hh;
}

const R = {};

// ── L: legit ────────────────────────────────────────────────────────────────────
const Lf = fullprove(ART_FIXED, baseInput("fixed"));
R.L_fixed_verifies = Lf.ok && verify(ART_FIXED, Lf.proof, Lf.pub);
const Lv = fullprove(ART_VULN, baseInput("vuln"));
R.L_vuln_verifies = Lv.ok && verify(ART_VULN, Lv.proof, Lv.pub);

// ── A1: nullifier malleability ───────────────────────────────────────────────────
// VULN — same note, same pool_id, two different pool_key_field => two valid nullifiers.
const X = randFr(); let Y = randFr(); while (Y === X) Y = randFr();
const a1x = fullprove(ART_VULN, baseInput("vuln", { pool_key_field: String(X), nullifier: String(poseidon3([DOMAIN_NULLIF, secret, X])) }));
const a1y = fullprove(ART_VULN, baseInput("vuln", { pool_key_field: String(Y), nullifier: String(poseidon3([DOMAIN_NULLIF, secret, Y])) }));
R.A1_vuln_double_spend =
  a1x.ok && a1y.ok &&
  verify(ART_VULN, a1x.proof, a1x.pub) && verify(ART_VULN, a1y.proof, a1y.pub) &&
  a1x.pub[0] !== a1y.pub[0]; // distinct nullifiers for one note in one pool
// FIXED — a non-canonical nullifier is UNSAT; the canonical nullifier is deterministic.
const a1bad = fullprove(ART_FIXED, baseInput("fixed", { nullifier: String(mod(canonicalNullifier + 1n)) }));
const d1 = fullprove(ART_FIXED, baseInput("fixed"));
const d2 = fullprove(ART_FIXED, baseInput("fixed"));
R.A1_fixed_rejects_noncanonical = !a1bad.ok;
R.A1_fixed_nullifier_deterministic =
  d1.ok && d2.ok && d1.pub[0] === d2.pub[0] && d1.pub[0] === String(canonicalNullifier);

// ── A2: non-boolean path selector ─────────────────────────────────────────────────
const a2idx = pathIndexZero.slice(); a2idx[0] = "2";
const rootBlend = blendRoot(2n);
const a2v = fullprove(ART_VULN, baseInput("vuln", { merkle_root: String(rootBlend), path_index: a2idx }));
R.A2_vuln_accepts_nonbool = a2v.ok && verify(ART_VULN, a2v.proof, a2v.pub);
const a2f = fullprove(ART_FIXED, baseInput("fixed", { merkle_root: String(rootBlend), path_index: a2idx }));
R.A2_fixed_rejects_nonbool = !a2f.ok;

// ── grade ─────────────────────────────────────────────────────────────────────────
const checks = [
  ["L  legit verifies (FIXED)",                 R.L_fixed_verifies],
  ["L  legit verifies (VULN, baseline)",        R.L_vuln_verifies],
  ["A1 VULN double-spend PRESENT",              R.A1_vuln_double_spend],
  ["A1 FIXED rejects non-canonical nullifier",  R.A1_fixed_rejects_noncanonical],
  ["A1 FIXED nullifier deterministic",          R.A1_fixed_nullifier_deterministic],
  ["A2 VULN non-boolean selector PRESENT",      R.A2_vuln_accepts_nonbool],
  ["A2 FIXED rejects non-boolean selector",     R.A2_fixed_rejects_nonbool],
];
console.log("\n=== shielded_withdraw_v3 hardening — held-out differential benchmark ===");
for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
if (a1bad.err) console.log(`  (FIXED non-canonical nullifier UNSAT: ${a1bad.err})`);
if (a2f.err) console.log(`  (FIXED non-boolean selector UNSAT: ${a2f.err})`);
const pass = checks.every(([, ok]) => ok);
console.log(`\nRESULT: ${pass ? "PASS — both holes closed on FIXED, present on VULN, legit intact" : "FAIL"}`);
console.log("JSON " + JSON.stringify({ pass, checks: Object.fromEntries(checks) }));
process.exit(pass ? 0 : 1);
