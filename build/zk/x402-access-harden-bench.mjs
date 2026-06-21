#!/usr/bin/env node
/**
 * Held-out adversarial benchmark — x402 access gate hardening (circuit layer).
 * Spec: circuits/X402_ACCESS_HARDENING_BENCH.md. Grades whether v2 closes the v1
 * free-witness tautology. Mirrors reputation-serverless-e2e.mjs tree machinery
 * (poseidon-lite == circomlib == sol_poseidon) so it can't drift from the real tree.
 *
 * No chain. Proves at the math layer that forged witnesses are UNSATISFIABLE (snarkjs
 * fullprove throws at witness-gen), legit proofs verify, and a public input cannot be
 * re-bound. Chain-layer cases (A3 self-made root, A4 replay, A6 cross-scope) are the
 * devnet e2e (separate), since they live in the program, not the circuit.
 *
 * Env: ART_V2 (dir with x402_access_v2.wasm + _final.zkey + _vk.json),
 *      ART_V1 (dir with x402_access.wasm + _final.zkey + _vk.json).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const ART_V2 = process.env.ART_V2 ?? "/art/v2";
const ART_V1 = process.env.ART_V1 ?? "/art/v1";
const SNARKJS = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");
const { poseidon2, poseidon4, poseidon5 } = await import("poseidon-lite");

const DEPTH = 10, DOMAIN_ACCESS = 11n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;

// depth-10 Poseidon tree from a leaves array (idx -> leaf), root + authentication path
function buildTree(leafByIdx) {
  let level = new Array(1 << DEPTH).fill(0n);
  for (const [idx, leaf] of Object.entries(leafByIdx)) level[Number(idx)] = leaf;
  const tree = [level];
  for (let d = 0; d < DEPTH; d++) {
    const nx = new Array(level.length >> 1);
    for (let i = 0; i < nx.length; i++) nx[i] = poseidon2([level[2 * i], level[2 * i + 1]]);
    tree.push(nx); level = nx;
  }
  const pathOf = (idx) => {
    const el = [], ix = []; let i = Number(idx);
    for (let d = 0; d < DEPTH; d++) { const bit = i & 1; ix.push(bit); el.push(tree[d][bit ? i - 1 : i + 1]); i >>= 1; }
    return { el, ix };
  };
  return { root: tree[DEPTH][0], pathOf };
}

function fullprove(artDir, circuit, input) {
  const tmp = mkdtempSync(join(tmpdir(), "bench-"));
  const inP = join(tmp, "in.json"), pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(inP, JSON.stringify(input));
  try {
    execFileSync(process.execPath,
      [SNARKJS, "groth16", "fullprove", inP, join(artDir, `${circuit}.wasm`), join(artDir, `${circuit}_final.zkey`), pfP, pubP],
      { stdio: "pipe" });
    const proof = JSON.parse(readFileSync(pfP, "utf8")), pub = JSON.parse(readFileSync(pubP, "utf8"));
    rmSync(tmp, { recursive: true, force: true });
    return { ok: true, proof, pub };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: (e.stderr?.toString() || e.message || "").split("\n").slice(-4).join(" ").slice(0, 160) };
  }
}

function verify(artDir, circuit, proof, pub) {
  const tmp = mkdtempSync(join(tmpdir(), "vrf-"));
  const pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(pfP, JSON.stringify(proof)); writeFileSync(pubP, JSON.stringify(pub));
  try {
    const out = execFileSync(process.execPath, [SNARKJS, "groth16", "verify", join(artDir, `${circuit}_vk.json`), pubP, pfP], { stdio: "pipe" }).toString();
    rmSync(tmp, { recursive: true, force: true });
    return /OK/.test(out);
  } catch { rmSync(tmp, { recursive: true, force: true }); return false; }
}

// shared identity + a real settled receipt leaf
const secret = randFr(), agent_id = randFr();
const agent_commitment = poseidon2([secret, agent_id]);
const scope_hash = randFr(), epoch = 7n;
const nullifier = poseidon4([DOMAIN_ACCESS, secret, scope_hash, epoch]);
const realAmount = 1000n, threshold = 500n;
const ts = 1_700_000_000n, counterparty = randFr(), receipt_nonce = randFr();
const realLeaf = poseidon5([agent_commitment, realAmount, ts, counterparty, receipt_nonce]);
const realTree = buildTree({ 0: realLeaf });
const realPath = realTree.pathOf(0);

const v2base = {
  root: realTree.root.toString(), threshold: threshold.toString(), scope_hash: scope_hash.toString(),
  epoch: epoch.toString(), nullifier: nullifier.toString(), agent_commitment: agent_commitment.toString(),
  secret: secret.toString(), agent_id: agent_id.toString(), amount: realAmount.toString(),
  timestamp: ts.toString(), counterparty: counterparty.toString(), receipt_nonce: receipt_nonce.toString(),
  path_elements: realPath.el.map(String), path_index: realPath.ix.map(String),
};

const grades = [];
const grade = (id, desc, pass, detail) => { grades.push({ id, desc, pass, detail }); console.log(`  [${pass ? "PASS" : "FAIL"}] ${id} ${desc} — ${detail}`); };

console.log("\n=== x402 access hardening — held-out adversarial benchmark (circuit layer) ===\n");

// ── V1: reproduce the tautology on the OLD circuit (invented balance, no backing) ──
{
  const v1in = { commitment: poseidon2([secret, agent_id]).toString(), threshold: threshold.toString(),
    nullifier: poseidon2([secret, 99n]).toString(), secret: secret.toString(), agent_id: agent_id.toString(),
    balance: threshold.toString(), nonce: "99" };
  const r = fullprove(ART_V1, "x402_access", v1in);
  const verified = r.ok && verify(ART_V1, "x402_access", r.proof, r.pub);
  grade("V1", "v1 tautology (invented balance verifies)", verified, verified ? "forged proof VERIFIES — defect reproduced" : `unexpected: ${r.err || "verify false"}`);
}

// ── L1: legit v2 — real leaf, amount>=threshold, valid path ────────────────────────
let legit;
{
  legit = fullprove(ART_V2, "x402_access_v2", v2base);
  const verified = legit.ok && verify(ART_V2, "x402_access_v2", legit.proof, legit.pub);
  grade("L1", "legit access (real receipt >= threshold)", verified, verified ? "proof VERIFIES" : `unexpected: ${legit.err || "verify false"}`);
}

// ── A1: forge amount — invented amount, but path authenticates the REAL leaf ───────
{
  const forged = { ...v2base, amount: "999999999" }; // leaf no longer matches the authenticated path
  const r = fullprove(ART_V2, "x402_access_v2", forged);
  grade("A1", "forge amount (no real Merkle path)", !r.ok, !r.ok ? "witness-gen FAILS (Merkle unsatisfiable) — no proof exists" : "FORGED PROOF PRODUCED — tautology survived");
}

// ── A2: below threshold — real leaf with amount<threshold in its own valid tree ────
{
  const lowAmount = 100n;
  const lowLeaf = poseidon5([agent_commitment, lowAmount, ts, counterparty, receipt_nonce]);
  const lowTree = buildTree({ 0: lowLeaf }); const lp = lowTree.pathOf(0);
  const r = fullprove(ART_V2, "x402_access_v2", { ...v2base, root: lowTree.root.toString(),
    amount: lowAmount.toString(), path_elements: lp.el.map(String), path_index: lp.ix.map(String) });
  grade("A2", "below threshold (amount<threshold)", !r.ok, !r.ok ? "witness-gen FAILS (GreaterEqThan) — no proof exists" : "PROOF PRODUCED — threshold not enforced");
}

// ── A5: proof-lending — tamper agent_commitment public signal on a valid proof ─────
{
  if (!legit?.ok) grade("A5", "proof-lending (re-bind identity)", false, "skipped — L1 did not prove");
  else {
    // public.json order = circuit `public [...]`: root,threshold,scope_hash,epoch,nullifier,agent_commitment
    const tampered = [...legit.pub]; tampered[5] = randFr().toString();
    const verified = verify(ART_V2, "x402_access_v2", legit.proof, tampered);
    grade("A5", "proof-lending (re-bind identity)", !verified, !verified ? "verify FALSE with swapped agent_commitment — proof is identity-bound" : "VERIFIES with foreign identity — not bound");
  }
}

console.log("\n=== GRADE ===");
const want = { V1: true, L1: true, A1: true, A2: true, A5: true };
let allPass = true;
for (const g of grades) { if (!g.pass) allPass = false; }
const haveAll = ["V1", "L1", "A1", "A2", "A5"].every((id) => grades.find((g) => g.id === id));
console.log(grades.map((g) => `${g.id}:${g.pass ? "PASS" : "FAIL"}`).join("  "));
if (allPass && haveAll) {
  console.log("\n✅ HARDENING VERIFIED (circuit layer): v1 tautology reproduced; v2 forge/below-threshold/lending all blocked; legit passes.");
  console.log("   Chain-layer cases (A3 self-made root, A4 replay, A6 cross-scope) → devnet e2e.");
  process.exit(0);
} else {
  console.error("\n❌ GRADE FAILED — fix is NOT done. See FAIL rows above.");
  process.exit(1);
}
