#!/usr/bin/env node
/**
 * Groth16 proof demo — real, reproducible, honest.
 *
 * Generates a REAL Groth16 proof for the canonical null_proof circuit
 * (MiMCSponge commitment + nullifier + 7-level Merkle tree, BN254) using the
 * already-compiled artifacts in the dark-null-protocol tree, then:
 *   1. verifies the valid proof            → must PASS
 *   2. verifies a tampered public signal   → must FAIL (soundness)
 *
 * Writes evidence/zk/groth16-proof-demo.json + copies proof/public/vk.
 *
 * HONEST SCOPE — read before quoting this anywhere:
 *   - This is a real Groth16 proof on BN254. The math is real and reproducible.
 *   - The proving key (null_proof_final.zkey) is from a LOCAL DEVELOPMENT setup,
 *     NOT a public multi-party ceremony (see dark-null-protocol/CEREMONY.md).
 *     It is NOT mainnet trust by itself.
 *   - This demo is OFF-CHAIN proof generation + verification. The on-chain
 *     verifier (dark_bn254_gate) is fail-closed pending audit.
 *   - What this proves: the ZK pipeline is real, not vaporware.
 *   - What it does NOT prove: audited, mainnet-ready, or safe fund settlement.
 *
 * Run: npm run zk:demo
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, "..", "..");
const DNP_ROOT   = join(REPO_ROOT, ".tools", "external", "dark-null-protocol");

const SNARKJS    = join(DNP_ROOT, "node_modules", "snarkjs", "build", "cli.cjs");
const WASM       = join(DNP_ROOT, "circuits", "null_proof_js", "null_proof.wasm");
const ZKEY       = join(DNP_ROOT, "circuits", "null_proof_final.zkey");
const VK         = join(DNP_ROOT, "circuits", "vk.json");
const R1CS       = join(DNP_ROOT, "circuits", "null_proof.r1cs");
const CIRCUIT    = join(DNP_ROOT, "circuits", "null_proof.circom");

const OUT_DIR    = join(REPO_ROOT, "evidence", "zk");
const WORK_DIR   = join(DNP_ROOT, "out_demo");

function sha256(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ── Preflight ───────────────────────────────────────────────────────────────
for (const [label, p] of [["snarkjs", SNARKJS], ["wasm", WASM], ["zkey", ZKEY], ["vk", VK]]) {
  if (!existsSync(p)) fail(`missing ${label}: ${p}`);
}
mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Canonical inputs (match dark-null-protocol/tests/canonical-proof-flow) ───
const receiverToken = Array.from({ length: 32 }, (_, i) => i + 1);
const mint          = Array.from({ length: 32 }, (_, i) => i + 33);
const part = (b) =>
  BigInt("0x" + Buffer.concat([Buffer.alloc(16), Buffer.from(b)]).toString("hex")).toString();

const inputs = {
  amount: "1000000",
  receiver_token_part_0: part(receiverToken.slice(0, 16)),
  receiver_token_part_1: part(receiverToken.slice(16, 32)),
  mint_part_0: part(mint.slice(0, 16)),
  mint_part_1: part(mint.slice(16, 32)),
  blinding: "7",
  nullifier_secret: "99",
  pathElements: Array(7).fill("0"),
  pathIndices: Array(7).fill(0),
};

const inputPath    = join(WORK_DIR, "input.json");
const proofPath    = join(WORK_DIR, "proof.json");
const publicPath   = join(WORK_DIR, "public.json");
const tamperedPath = join(WORK_DIR, "public-tampered.json");
writeFileSync(inputPath, JSON.stringify(inputs, null, 2));

console.log("\n=== Groth16 proof demo — null_proof circuit (BN254) ===\n");

// ── 1. Generate a real proof ──────────────────────────────────────────────────
console.log("[1/3] Generating proof (witness + groth16 prove)...");
try {
  execFileSync(process.execPath,
    [SNARKJS, "groth16", "fullprove", inputPath, WASM, ZKEY, proofPath, publicPath],
    { stdio: "pipe" });
} catch (e) {
  fail(`proof generation errored: ${e.message}`);
}
const proof  = JSON.parse(readFileSync(proofPath, "utf8"));
const pub     = JSON.parse(readFileSync(publicPath, "utf8"));
console.log(`      proof protocol=${proof.protocol} curve=${proof.curve}, ${pub.length} public signals`);

// ── 2. Verify the valid proof (must pass) ─────────────────────────────────────
console.log("[2/3] Verifying valid proof (must PASS)...");
let validVerified = false;
try {
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, publicPath, proofPath], { stdio: "pipe" });
  validVerified = true;
  console.log("      OK — valid proof verified");
} catch {
  fail("valid proof did NOT verify — pipeline broken");
}

// ── 3. Tamper a public signal (must fail) ─────────────────────────────────────
console.log("[3/3] Verifying tampered proof (must FAIL — soundness)...");
const mutated = [...pub];
mutated[3] = (BigInt(mutated[3]) + 1n).toString(); // amount signal
writeFileSync(tamperedPath, JSON.stringify(mutated));
let tamperRejected = false;
try {
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, tamperedPath, proofPath], { stdio: "pipe" });
  fail("SECURITY: tampered proof was ACCEPTED — soundness broken");
} catch {
  tamperRejected = true;
  console.log(`      REJECTED — amount ${pub[3]} → ${mutated[3]} fails verification`);
}

// ── Copy shareable artifacts ──────────────────────────────────────────────────
copyFileSync(proofPath,  join(OUT_DIR, "proof.json"));
copyFileSync(publicPath, join(OUT_DIR, "public.json"));
copyFileSync(VK,         join(OUT_DIR, "vk.json"));

// ── Evidence record ───────────────────────────────────────────────────────────
const evidence = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  demo: "groth16-null-proof",
  curve: "bn254",
  protocol: "groth16",
  circuit: {
    source: "dark-null-protocol/circuits/null_proof.circom",
    relation: "MiMCSponge commitment(7) + nullifier(1) + 7-level Merkle tree",
    publicInputs: 8,
    bindsPublic: ["amount", "receiver_token_part_0", "receiver_token_part_1", "mint_part_0", "mint_part_1"],
    derivedOutputs: ["commitment", "nullifier", "root"],
  },
  result: {
    proofGenerated: validVerified,
    validProofVerified: validVerified,
    tamperedProofRejected: tamperRejected,
    tamperedSignal: "amount",
  },
  artifactHashes: {
    circuit:  sha256(CIRCUIT),
    r1cs:     sha256(R1CS),
    zkey:     sha256(ZKEY),
    wasm:     sha256(WASM),
    vkJson:   sha256(VK),
    proofJson: sha256(proofPath),
    publicJson: sha256(publicPath),
  },
  onChainVerifier: {
    crate: "groth16-solana",
    rustVk: "dark-null-protocol/src/verifying_key.rs",
    status: "fail-closed pending audit — dark_bn254_gate rejects all proofs until a mainnet_ready VK is wired",
  },
  honestCaveats: [
    "Real Groth16 proof on BN254 — generated and verified locally, reproducible.",
    "Proving key is a LOCAL DEVELOPMENT setup, NOT a public multi-party ceremony (see dark-null-protocol/CEREMONY.md). Not mainnet trust by itself.",
    "This is OFF-CHAIN proof gen + verification. On-chain verifier is fail-closed pending audit.",
    "Proves: the ZK pipeline is real, not vaporware. Does NOT prove: audited, mainnet-ready, or safe fund settlement.",
  ],
};

writeFileSync(join(OUT_DIR, "groth16-proof-demo.json"), JSON.stringify(evidence, null, 2) + "\n");

console.log("\n=== Result ===");
console.log(`Valid proof verified : ${validVerified ? "PASS" : "FAIL"}`);
console.log(`Tampered rejected    : ${tamperRejected ? "PASS" : "FAIL"}`);
console.log(`Evidence             : evidence/zk/groth16-proof-demo.json`);
console.log(`Artifacts            : evidence/zk/{proof,public,vk}.json`);

if (validVerified && tamperRejected) {
  console.log("\nPASS: real Groth16 proof generated, verified, and tamper-rejected.");
  process.exit(0);
}
process.exit(1);
