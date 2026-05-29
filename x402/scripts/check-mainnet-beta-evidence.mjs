#!/usr/bin/env node
/**
 * DNA x402 mainnet open-beta evidence gate.
 *
 * Validates evidence/mainnet/MAINNET_BETA_EVIDENCE.json (current schema v1.0).
 * Also accepts the legacy x402/MAINNET_BETA_EVIDENCE.json path for back-compat.
 *
 * Run: npm --prefix x402 run check:mainnet:beta
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const json          = args.has("--json");
const allowBlockers = args.has("--allow-blockers");

// ── Evidence path: canonical new location; fall back to legacy ────────────────
const evidencePathNew    = path.join(repoRoot, "evidence", "mainnet", "MAINNET_BETA_EVIDENCE.json");
const evidencePathLegacy = path.join(repoRoot, "x402", "MAINNET_BETA_EVIDENCE.json");
const evidencePath       = existsSync(evidencePathNew) ? evidencePathNew : evidencePathLegacy;

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function add(blockers, id, summary, required) {
  blockers.push({ id, severity: "blocker", summary, required });
}
function isBase58ish(v) {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(v);
}
function isHex40(v) {
  return typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
}
function currentHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── Schema v1.0 checker (current evidence/mainnet/MAINNET_BETA_EVIDENCE.json) ──
function checkV1(e, blockers) {
  const head = currentHead();

  // Deploy commit must be present and a valid 40-char hex hash
  const deployCommit = e.deployCommit ?? e.commitHash;
  if (!isHex40(deployCommit))
    add(blockers, "deploy-commit", "deployCommit missing or malformed.", "Set to the 40-char hex deploy commit hash.");

  // evidencePackCommit or commitHash must also be present
  const evidenceCommit = e.evidencePackCommit ?? e.commitHash;
  if (!isHex40(evidenceCommit))
    add(blockers, "evidence-commit", "evidencePackCommit missing or malformed.", "Set to the evidence generation commit hash.");

  // Cluster
  if (e.cluster !== "mainnet-beta")
    add(blockers, "cluster", "cluster must be mainnet-beta.", "Redeploy to mainnet-beta.");

  // Deploy wallet (pause authority equivalent)
  if (!isBase58ish(e.deployWallet))
    add(blockers, "deploy-wallet", "deployWallet missing or malformed.", "Set to the deploy wallet pubkey.");

  // Audit status must disclose pre-audit
  const auditOk = typeof e.auditStatus === "string" && /pre.audit|pending|unaudited/i.test(e.auditStatus);
  if (!auditOk)
    add(blockers, "audit-status", "auditStatus must declare pre-audit or pending.", "Set auditStatus to a string containing 'pre-audit' or 'pending'.");

  // No backend custody
  if (e.backendCustody !== false)
    add(blockers, "backend-custody", "backendCustody must be false.", "SDK must not hold user funds.");

  // No backend signing
  if (e.backendSigning !== false)
    add(blockers, "backend-signing", "backendSigning must be false.", "Payments must be user-signed, not backend-signed.");

  // Programs: must have all 8 with valid base58 IDs
  const programs = Array.isArray(e.programs)
    ? Object.fromEntries(e.programs.map((p) => [p.programLabel ?? p.configKey, p.programId]))
    : e.programs ?? {};

  const required = ["dark_semaphore", "dark_secp256r1_vault", "dark_secp256k1_auth",
    "null_token_hook", "null_lottery", "null_mint_gate", "receipt_anchor", "dark_proof_gate_lite"];
  for (const label of required) {
    const id = programs[label];
    if (!isBase58ish(id))
      add(blockers, `program-${label}`, `Program ID for ${label} missing or invalid.`, `Deploy ${label} to mainnet-beta.`);
  }

  // Write smoke: should have a real tx signature
  if (!e.writeSmokeSignature)
    add(blockers, "write-smoke", "writeSmokeSignature missing.", "Run scripts/post-mainnet/10-smoke-proofgate-write.mjs and commit result.");

  // Mayhem: must have passed
  if (e.mayhemResults?.allPassed !== true && e.mayhemResults?.passedCount < e.mayhemResults?.totalScenarios)
    add(blockers, "mayhem", "Mayhem suite did not pass.", "Run npm run mainnet:mayhem and fix failures.");
}

// ── Legacy schema checker (v0, x402/MAINNET_BETA_EVIDENCE.json) ───────────────
function checkLegacy(e, blockers) {
  if (e.schema !== "dna-x402-mainnet-open-beta-evidence-v1")
    add(blockers, "schema", "Unknown schema.", "Use schema dna-x402-mainnet-open-beta-evidence-v1.");
  if (!isHex40(e.release_commit ?? ""))
    add(blockers, "release-commit", "release_commit missing or malformed.", "Set to the beta release commit hash.");
  if (e.beta?.status !== "open-beta")
    add(blockers, "beta-status", "beta.status must be open-beta.", "Set beta.status to open-beta.");
  if (e.beta?.risk_disclosure !== "unaudited-open-beta")
    add(blockers, "risk-disclosure", "Risk disclosure must be unaudited-open-beta.", "Set explicitly.");
  if (e.beta?.production_claims_allowed !== false)
    add(blockers, "production-claims", "production_claims_allowed must be false.", "Set to false.");
  if (e.beta?.operator_custody !== false)
    add(blockers, "operator-custody", "operator_custody must be false.", "No backend key custody allowed in beta.");
  if (e.beta?.kill_switch_enabled !== true)
    add(blockers, "kill-switch", "kill_switch_enabled must be true.", "Document and set kill switch authority.");
  if (e.deploy?.cluster !== "mainnet-beta")
    add(blockers, "cluster", "deploy.cluster must be mainnet-beta.", "Deploy to mainnet-beta first.");
  if (!["locked","multisig","timelock-multisig"].includes(e.deploy?.upgrade_authority_policy))
    add(blockers, "upgrade-policy", "upgrade_authority_policy must be locked/multisig/timelock-multisig.", "Set before deploying.");
  if (!isBase58ish(e.deploy?.pause_authority))
    add(blockers, "pause-authority", "pause_authority is missing or malformed.", "Publish pause authority pubkey.");
  if (e.audit?.status !== "pending")
    add(blockers, "audit-status", "audit.status must be pending for beta.", "Set to pending.");
  if (e.audit?.external_audit_required_before_production !== true)
    add(blockers, "audit-gate", "external_audit_required_before_production must be true.", "Set to true.");
  const programs = e.programs ?? {};
  for (const [name, id] of Object.entries(programs)) {
    if (!isBase58ish(id))
      add(blockers, `program-${name}`, `Program ID for ${name} is missing or a placeholder.`, `Deploy ${name} and fill in the real program ID.`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
function collectBlockers() {
  const blockers = [];
  if (!existsSync(evidencePath)) {
    add(blockers, "beta-evidence-file",
      "MAINNET_BETA_EVIDENCE.json not found at evidence/mainnet/ or x402/.",
      "Run npm run mainnet:evidence to generate.");
    return blockers;
  }

  const e          = readJson(evidencePath);
  const isV1Schema = (e.schemaVersion === "1.0") || (e.deployCommit != null) || (e.cluster != null && !e.deploy);

  if (isV1Schema) {
    console.log(`Evidence: ${path.relative(repoRoot, evidencePath)} (schema v1.0)`);
    checkV1(e, blockers);
  } else {
    console.log(`Evidence: ${path.relative(repoRoot, evidencePath)} (legacy schema)`);
    checkLegacy(e, blockers);
  }

  return blockers;
}

const blockers = collectBlockers();
const report   = {
  status:    blockers.length === 0 ? "BETA_READY" : "BLOCKED",
  checkedAt: new Date().toISOString(),
  blockers,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (blockers.length === 0) {
  console.log("DNA x402 mainnet beta evidence check passed — BETA_READY.");
} else {
  console.error("DNA x402 mainnet beta evidence check BLOCKED:");
  for (const b of blockers) {
    console.error(`- [${b.severity}] ${b.id}: ${b.summary}`);
    console.error(`  Fix: ${b.required}`);
  }
}

if (blockers.length > 0 && !allowBlockers) process.exit(1);
