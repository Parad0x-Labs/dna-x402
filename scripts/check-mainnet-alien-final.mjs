#!/usr/bin/env node
/**
 * check-mainnet-alien-final.mjs
 * Blocks mainnet deploy unless all requirements exist.
 * Run from G:\DNA x402 directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const BASE = process.cwd();
const EVIDENCE_DIR = path.join(BASE, "dist/alien-final/evidence");

function exists(p) { return fs.existsSync(path.join(BASE, p)); }
function readEvidence(name) {
  const p = path.join(EVIDENCE_DIR, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}${detail ? " -- " + detail : ""}`);
    fail++;
  }
}

console.log("=== Dark Null Mainnet Alien Final Gate ===\n");

// 1. Explicit env var
check(
  "ALLOW_MAINNET_DEPLOY=YES",
  process.env.ALLOW_MAINNET_DEPLOY === "YES",
  "Set env var ALLOW_MAINNET_DEPLOY=YES to proceed"
);

// 2. Audit evidence
const audit = readEvidence("audit_signed.json");
check(
  "Audit sign-off evidence exists",
  audit !== null,
  "Missing: dist/alien-final/evidence/audit_signed.json"
);

// 3. cargo test on current commit
let testsPass = false;
try {
  const result = execSync("cargo test --workspace --quiet 2>&1", { encoding: "utf8", timeout: 300000 });
  testsPass = !result.includes("FAILED") && !result.includes("error[");
} catch { testsPass = false; }
check("cargo test --workspace passes", testsPass, "Run: cargo test --workspace");

// 4. cargo audit (if installed)
let cargoAuditClean = false;
try {
  execSync("cargo audit --version", { stdio: "pipe" });
  try {
    execSync("cargo audit 2>&1", { encoding: "utf8", timeout: 60000 });
    cargoAuditClean = true;
  } catch { cargoAuditClean = false; }
} catch {
  console.log("  WARNING: cargo audit not installed -- install: cargo install cargo-audit");
  fail++;
  cargoAuditClean = false;
}
check("cargo audit -- no critical/high vulns", cargoAuditClean);

// 5. cargo deny (if installed)
let cargoDenyClean = false;
try {
  execSync("cargo deny --version", { stdio: "pipe" });
  try {
    execSync("cargo deny check 2>&1", { encoding: "utf8", timeout: 60000 });
    cargoDenyClean = true;
  } catch { cargoDenyClean = false; }
} catch {
  console.log("  WARNING: cargo deny not installed -- install: cargo install cargo-deny");
  fail++;
}
check("cargo deny check passes", cargoDenyClean);

// 6. Claim checker
let claimCheckPasses = false;
try {
  execSync("node scripts/check-alien-final-claims.mjs", { encoding: "utf8", timeout: 30000 });
  claimCheckPasses = true;
} catch { claimCheckPasses = false; }
check("check-alien-final-claims.mjs passes", claimCheckPasses, "Run: node scripts/check-alien-final-claims.mjs");

// 7. Signed deploy plan
const deployPlan = readEvidence("signed_deploy_plan.json");
check(
  "Signed deploy plan",
  deployPlan !== null,
  "Missing: dist/alien-final/evidence/signed_deploy_plan.json"
);

// 8. SOL budget (check deploy plan has budget < 5 SOL = 5_000_000_000 lamports)
const maxBudget = 5_000_000_000;
check(
  "Deploy SOL budget within limits",
  deployPlan && deployPlan.max_deploy_lamports && deployPlan.max_deploy_lamports <= maxBudget,
  `Budget must be <= ${maxBudget} lamports (5 SOL)`
);

// 9. Upgrade authority policy
check(
  "Upgrade authority policy defined",
  deployPlan && deployPlan.upgrade_authority_policy,
  "Deploy plan must include upgrade_authority_policy field"
);

// 10. HMAC fix evidence
const hmacEvidence = readEvidence("hmac_rfc2104.json");
check(
  "HMAC RFC2104 fix evidence",
  hmacEvidence !== null,
  "Missing: dist/alien-final/evidence/hmac_rfc2104.json"
);

// Optional: check active claim evidence
const claims = [
  { name: "x402_devnet",        file: "x402_devnet_real.json" },
  { name: "poseidon_real",      file: "poseidon_real.json" },
  { name: "zk_verifier_real",   file: "zk_verifier_real.json" },
  { name: "zk_compression_real",file: "zk_compression_real.json" },
  { name: "bonsol_real",        file: "bonsol_real.json" },
  { name: "risc0_real",         file: "risc0_real.json" },
];

console.log("\n--- Optional evidence files (only required if feature claimed) ---");
for (const { name, file } of claims) {
  const ev = readEvidence(file);
  if (ev) {
    console.log(`  PRESENT: ${name}: evidence present`);
  } else {
    console.log(`  ABSENT:  ${name}: not present -- OK unless this feature is publicly claimed`);
  }
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("\nMAINNET DEPLOY BLOCKED -- resolve all failures above");
  console.log("This is expected -- Dark Null is devnet-only at this stage.");
  process.exit(1);
} else {
  console.log("\nAll gates passed -- mainnet deploy authorized.");
  console.log("Proceed with: solana program deploy target/deploy/<program>.so --url mainnet-beta");
}
