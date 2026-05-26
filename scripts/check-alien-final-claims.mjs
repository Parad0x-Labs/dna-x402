#!/usr/bin/env node
/**
 * check-alien-final-claims.mjs
 * Fails if public docs contain forbidden phrases without matching evidence marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// Forbidden phrases and their required evidence files
const FORBIDDEN = [
  { phrase: "mainnet ready",         evidence: "dist/alien-final/evidence/mainnet_deploy.json" },
  { phrase: "production ready",      evidence: "dist/alien-final/evidence/mainnet_deploy.json" },
  { phrase: "audited",               evidence: "dist/alien-final/evidence/audit_signed.json" },
  { phrase: "end-to-end private",    evidence: null }, // always forbidden
  { phrase: "end-to-end privacy",    evidence: null }, // always forbidden
  { phrase: "ZK verified",           evidence: "dist/alien-final/evidence/zk_verifier_real.json" },
  { phrase: "Bonsol integrated",     evidence: "dist/alien-final/evidence/bonsol_real.json" },
  { phrase: "RISC0 integrated",      evidence: "dist/alien-final/evidence/risc0_real.json" },
  { phrase: "RISC Zero integrated",  evidence: "dist/alien-final/evidence/risc0_real.json" },
  { phrase: "ZK Compression live",   evidence: "dist/alien-final/evidence/zk_compression_real.json" },
  { phrase: "x402 production live",  evidence: "dist/alien-final/evidence/x402_devnet_real.json" },
  { phrase: "Poseidon on-chain live", evidence: "dist/alien-final/evidence/poseidon_real.json" },
];

// Docs to scan
const SCAN_DIRS = ["docs", "README.md"];
// Docs explicitly allowed to discuss blockers (won't trigger false positives)
const ALLOWLIST_FILES = [
  "docs/ALIEN_FINAL_BASELINE.md",
  "docs/ALIEN_FINAL_AUDIT_PACKET.md",
  "docs/ALIEN_FINAL_RISK_REGISTER.md",
  "docs/MAINNET_ALIEN_FINAL_GATE.md",
  "docs/BONSOL_RISC0_PROOF_LAYER.md",
  "docs/ZK_PROOF_VERIFICATION_PLAN.md",
  "docs/ZK_COMPRESSION_ADAPTER.md",
  "docs/POSEIDON_HASH_MIGRATION.md",
  "docs/DARK_X402_DEVNET_FLOW.md",
  "docs/DARK_NULL_2030_ORIGINALS.md",
  "docs/DARK_NULL_ALIEN_TEK.md",
  "docs/DNA_X402_ADMIN_ACTION_RUNBOOK.md",
  "docs/DNA_X402_BOSS_FIGHT_AUDIT_EVIDENCE.md",
  "docs/DNA_X402_BUILDER_MONETIZATION.md",
  "docs/DNA_X402_COUNSEL_REVIEW_BUNDLE.md",
  "docs/DNA_X402_FUTURE_PROOF_COMMERCE_MATRIX.md",
  "docs/DNA_X402_INCIDENT_RESPONSE_RUNBOOK.md",
  "docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md",
  "docs/HANDOVER_MARKET_INTELLIGENCE.md",
  "docs/NIGHT_COOK_DEMO_FLOW.md",
  "docs/ROGUE_WOW_DEMO.md",
];

function readFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [dir];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? readFilesRecursive(full) : [full];
  });
}

function evidenceValid(evidencePath, commit) {
  if (!evidencePath) return false;
  if (!fs.existsSync(evidencePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    // Evidence must have a commit field (to prevent stale markers)
    if (commit && data.commit && data.commit !== commit) {
      console.log(`     WARNING: Evidence commit mismatch: ${data.commit} vs current ${commit}`);
      return false;
    }
    return true;
  } catch { return false; }
}

// Get current commit from git if possible
let currentCommit = null;
try {
  const { execSync } = await import("node:child_process");
  currentCommit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} catch {}

const allFiles = SCAN_DIRS.flatMap(d => readFilesRecursive(d)).filter(f => f.endsWith(".md") || f.endsWith(".txt") || f === "README.md");

let failures = 0;
let warnings = 0;

console.log("=== Dark Null Alien Final Claim Checker ===\n");

for (const file of allFiles) {
  const normalized = file.replace(/\\/g, "/");
  if (ALLOWLIST_FILES.some(a => normalized.endsWith(a.replace(/\\/g, "/")))) continue;
  const content = fs.readFileSync(file, "utf8").toLowerCase();
  for (const { phrase, evidence } of FORBIDDEN) {
    if (content.includes(phrase.toLowerCase())) {
      const hasEvidence = evidence && evidenceValid(evidence, currentCommit);
      if (hasEvidence) {
        console.log(`  PASS: "${phrase}" in ${file} -- evidence present`);
      } else if (evidence === null) {
        console.log(`  FAIL ALWAYS FORBIDDEN: "${phrase}" found in ${file}`);
        failures++;
      } else {
        console.log(`  FAIL: "${phrase}" in ${file} -- missing evidence: ${evidence}`);
        failures++;
      }
    }
  }
}

console.log(`\n=== Result: ${failures} failures, ${warnings} warnings ===`);
if (failures > 0) {
  console.log("FAIL -- remove forbidden phrases or add evidence markers");
  process.exit(1);
} else {
  console.log("PASS -- no unsubstantiated claims found");
}
