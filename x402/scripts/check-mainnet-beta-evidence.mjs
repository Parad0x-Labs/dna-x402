#!/usr/bin/env node
/**
 * DNA x402 mainnet open-beta evidence gate.
 * Blocks unless MAINNET_BETA_EVIDENCE.json exists with real deployment data.
 * Run: npm run check:mainnet:beta
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const allowBlockers = args.has("--allow-blockers");

const evidencePath = path.join(repoRoot, "x402", "MAINNET_BETA_EVIDENCE.json");

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function add(blockers, id, summary, required) {
  blockers.push({ id, severity: "blocker", summary, required });
}
function isPlaceholder(v) {
  return typeof v !== "string" || !v.trim() || /^REPLACE_WITH_/i.test(v) || /PENDING|TODO/i.test(v);
}
function isBase58ish(v) {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(v);
}
function currentHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore","pipe","ignore"], shell: process.platform === "win32" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function collectBlockers() {
  const blockers = [];
  if (!existsSync(evidencePath)) {
    add(blockers, "beta-evidence-file", "MAINNET_BETA_EVIDENCE.json is missing.", "Create from MAINNET_BETA_EVIDENCE.example.json after real mainnet-beta deployment.");
    return blockers;
  }
  const e = readJson(evidencePath);
  const head = currentHead();

  if (e.schema !== "dna-x402-mainnet-open-beta-evidence-v1")
    add(blockers, "schema", "Unknown schema.", "Use schema dna-x402-mainnet-open-beta-evidence-v1.");
  if (!/^[0-9a-f]{40}$/i.test(e.release_commit ?? ""))
    add(blockers, "release-commit", "release_commit missing or malformed.", "Set to the beta release commit hash.");
  else if (head && e.release_commit !== head)
    add(blockers, "release-commit-current", "release_commit does not match HEAD.", "Check out the evidenced commit.");
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
  return blockers;
}

const blockers = collectBlockers();
const report = { status: blockers.length === 0 ? "BETA_READY" : "BLOCKED", checkedAt: new Date().toISOString(), blockers };

if (json) { console.log(JSON.stringify(report, null, 2)); }
else if (blockers.length === 0) { console.log("DNA x402 mainnet beta evidence check passed."); }
else {
  console.error("DNA x402 mainnet beta evidence check failed:");
  for (const b of blockers) {
    console.error(`- [${b.severity}] ${b.id}: ${b.summary}`);
    console.error(`  Fix: ${b.required}`);
  }
}

if (blockers.length > 0 && !allowBlockers) process.exit(1);
