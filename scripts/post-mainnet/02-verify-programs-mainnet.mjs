#!/usr/bin/env node
/**
 * Verify all 8 DNA x402 programs are live on mainnet-beta.
 *
 * Reads configs/mainnet.commercial.json, queries each program via
 * `solana program show --output json`, writes:
 *   - evidence/mainnet/programs.json
 *   - docs/MAINNET_PROGRAMS.md
 *
 * Exit 0 if all 8 verified, exit 1 if any fail.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const PROGRAM_LABELS = {
  semaphore:    "dark_semaphore",
  vault:        "dark_secp256r1_vault",
  ethAuth:      "dark_secp256k1_auth",
  tokenHook:    "null_token_hook",
  lottery:      "null_lottery",
  mintGate:     "null_mint_gate",
  receiptAnchor:"receipt_anchor",
  proofGate:    "dark_proof_gate_lite",
};

function explorerUrl(id) {
  return `https://explorer.solana.com/address/${id}?cluster=mainnet-beta`;
}

function queryProgram(programId) {
  const cmd = `solana program show ${programId} -u mainnet-beta --output json`;
  let raw;
  try {
    raw = execSync(cmd, { encoding: "utf8", timeout: 30000 });
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), programId };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `JSON parse failed: ${raw.slice(0, 200)}`, programId };
  }

  // solana CLI `program show --output json` shape for BPF upgradeable programs:
  // { programId, owner: "BPFLoaderUpgradeab1e...", programdataAddress, authority,
  //   lastDeploySlot, dataLen, lamports }
  // There is NO "executable" field — executable status is implied by owner = BPF loader.
  const programData = parsed.program ?? parsed;
  const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  const executable = programData.owner === BPF_LOADER || programData.programdataAddress != null;
  const authority  = programData.authority ?? programData.upgradeAuthority ?? null;
  const slot       = programData.lastDeploySlot ?? programData.lastDeployedSlot ?? programData.lastUpdatedSlot ?? null;
  const dataLen    = programData.dataLen ?? programData.dataSize ?? null;
  const lamports   = programData.lamports ?? null;

  return {
    ok: true,
    programId,
    executable: Boolean(executable),
    authority,
    lastDeployedSlot: slot,
    dataLen,
    lamports,
  };
}

async function main() {
  const configPath = join(REPO_ROOT, "configs", "mainnet.commercial.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const { programs } = config;

  mkdirSync(join(REPO_ROOT, "evidence", "mainnet"), { recursive: true });
  mkdirSync(join(REPO_ROOT, "docs"), { recursive: true });

  const results = [];
  let failures = 0;

  for (const [configKey, programLabel] of Object.entries(PROGRAM_LABELS)) {
    const programId = programs[configKey];
    if (!programId) {
      console.error(`FAIL: no program ID found for key '${configKey}' in config`);
      failures++;
      results.push({ ok: false, configKey, programLabel, error: "Missing from config" });
      continue;
    }

    process.stdout.write(`Verifying ${programLabel} (${programId})... `);
    const result = queryProgram(programId);

    if (!result.ok) {
      console.log("FAIL");
      console.error(`  Error: ${result.error}`);
      failures++;
      results.push({ ok: false, configKey, programLabel, programId, error: result.error });
      continue;
    }

    if (!result.executable) {
      console.log("FAIL (not executable)");
      failures++;
      results.push({ ok: false, configKey, programLabel, programId, error: "Account exists but not executable" });
      continue;
    }

    console.log("OK");
    results.push({
      ok: true,
      configKey,
      programLabel,
      programId,
      executable: result.executable,
      authority: result.authority,
      lastDeployedSlot: result.lastDeployedSlot,
      dataLen: result.dataLen,
      lamports: result.lamports,
      explorerUrl: explorerUrl(programId),
    });
  }

  const timestamp = new Date().toISOString();

  // Write evidence JSON
  const evidencePayload = {
    schemaVersion: "1.0",
    generatedAt: timestamp,
    cluster: "mainnet-beta",
    totalPrograms: results.length,
    verifiedCount: results.filter(r => r.ok).length,
    failedCount: failures,
    programs: results,
  };

  const evidencePath = join(REPO_ROOT, "evidence", "mainnet", "programs.json");
  writeFileSync(evidencePath, JSON.stringify(evidencePayload, null, 2) + "\n");
  console.log(`\nEvidence written: evidence/mainnet/programs.json`);

  // Write markdown table
  const mdLines = [
    `# Mainnet-Beta Programs`,
    ``,
    `Generated: ${timestamp}  `,
    `Cluster: mainnet-beta  `,
    `Config: configs/mainnet.commercial.json`,
    ``,
    `| Program | ID | Executable | Authority | DataLen | Last Deployed Slot | Explorer |`,
    `|---------|-----|------------|-----------|---------|-------------------|----------|`,
  ];

  for (const r of results) {
    if (r.ok) {
      mdLines.push(
        `| ${r.programLabel} | \`${r.programId}\` | ${r.executable ? "yes" : "NO"} | \`${r.authority ?? "unknown"}\` | ${r.dataLen ?? "-"} | ${r.lastDeployedSlot ?? "-"} | [link](${r.explorerUrl}) |`
      );
    } else {
      mdLines.push(
        `| ${r.programLabel ?? r.configKey} | ${r.programId ?? "missing"} | FAIL | - | - | - | - |`
      );
    }
  }

  if (failures > 0) {
    mdLines.push(``, `> **WARNING: ${failures} program(s) failed verification.**`);
  } else {
    mdLines.push(``, `> All ${results.length} programs verified live on mainnet-beta.`);
  }

  const mdPath = join(REPO_ROOT, "docs", "MAINNET_PROGRAMS.md");
  writeFileSync(mdPath, mdLines.join("\n") + "\n");
  console.log(`Markdown written: docs/MAINNET_PROGRAMS.md`);

  // Summary
  console.log(`\n=== Verification Summary ===`);
  console.log(`Verified: ${results.filter(r => r.ok).length} / ${results.length}`);
  if (failures > 0) {
    console.error(`FAIL: ${failures} program(s) not verified`);
    process.exit(1);
  }

  console.log("PASS: All 8 programs verified executable on mainnet-beta");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
