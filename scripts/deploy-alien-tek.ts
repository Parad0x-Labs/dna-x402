/**
 * deploy-alien-tek.ts
 *
 * Deploys Dark Null Solana-Native Alien Tek programs to devnet.
 * Records program IDs back into docs/SOLANA_ALIEN_TEK.md.
 *
 * Usage:
 *   npx tsx scripts/deploy-alien-tek.ts
 *
 * Requires:
 *   - Solana CLI in PATH (or .tools/solana/bin/)
 *   - A funded keypair at DEPLOY_KEYPAIR_PATH (default: ~/.config/solana/id.json)
 *   - cargo build-sbf (Solana BPF toolchain)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT       = resolve(import.meta.dirname, "..");
const CLUSTER    = process.env.CLUSTER    ?? "devnet";
const RPC_URL    = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR    = process.env.DEPLOY_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;
const ALIEN_DOC  = join(ROOT, "docs", "SOLANA_ALIEN_TEK.md");

const PROGRAMS: Array<{ name: string; path: string; soName: string }> = [
  {
    name:   "dark_nullifier_banks",
    path:   join(ROOT, "programs", "dark_nullifier_banks"),
    soName: "dark_nullifier_banks.so",
  },
  {
    name:   "dark_compressed_receipts",
    path:   join(ROOT, "programs", "dark_compressed_receipts"),
    soName: "dark_compressed_receipts.so",
  },
  {
    name:   "dark_chaff",
    path:   join(ROOT, "programs", "dark_chaff"),
    soName: "dark_chaff.so",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): string {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: cwd ?? ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] });
}

function solanaCli(args: string): string {
  const bin = existsSync(join(ROOT, ".tools", "solana", "bin", "solana"))
    ? join(ROOT, ".tools", "solana", "bin", "solana")
    : "solana";
  return run(`${bin} ${args} --url ${RPC_URL} --keypair ${KEYPAIR}`);
}

function buildSbf(programPath: string): string {
  console.log(`\nBuilding BPF for ${programPath}`);
  run(
    `cargo build-sbf --manifest-path ${join(programPath, "Cargo.toml")}`,
    ROOT
  );
  // BPF binary ends up in target/deploy/
  const soPath = join(ROOT, "target", "deploy", PROGRAMS.find(p => p.path === programPath)!.soName);
  if (!existsSync(soPath)) {
    throw new Error(`Built .so not found at ${soPath}`);
  }
  return soPath;
}

function deployProgram(soPath: string, programPath: string): string {
  const keypairPath = join(programPath, "program-keypair.json");
  const args = existsSync(keypairPath)
    ? `program deploy ${soPath} --program-id ${keypairPath}`
    : `program deploy ${soPath}`;
  const output = solanaCli(args);
  // Extract program ID from output like "Program Id: <pubkey>"
  const match = output.match(/Program Id:\s+([A-Za-z0-9]{32,44})/);
  if (!match) throw new Error(`Could not parse program ID from:\n${output}`);
  return match[1];
}

function updateDocProgramId(programName: string, programId: string): void {
  let doc = readFileSync(ALIEN_DOC, "utf-8");
  doc = doc.replace(
    new RegExp(`(\\| ${programName}\\s+\\| devnet\\s+\\|)\\s+_pending deployment_`),
    `$1 \`${programId}\``
  );
  writeFileSync(ALIEN_DOC, doc, "utf-8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🚀 Dark Null Alien Tek — deploying to ${CLUSTER} (${RPC_URL})\n`);

  // Verify keypair exists
  if (!existsSync(KEYPAIR)) {
    console.error(`ERROR: Deploy keypair not found at ${KEYPAIR}`);
    console.error(`  Set DEPLOY_KEYPAIR_PATH or run: solana-keygen new`);
    process.exit(1);
  }

  // Check balance
  const balanceOutput = solanaCli("balance");
  console.log(`Payer balance: ${balanceOutput.trim()}`);

  const deployedIds: Record<string, string> = {};

  for (const program of PROGRAMS) {
    console.log(`\n── ${program.name} ──────────────────────────────────────`);
    try {
      const soPath    = buildSbf(program.path);
      const programId = deployProgram(soPath, program.path);
      deployedIds[program.name] = programId;
      console.log(`  ✅ deployed: ${programId}`);
      updateDocProgramId(program.name, programId);
    } catch (err) {
      console.error(`  ❌ failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  console.log("\n── Summary ──────────────────────────────────────────────");
  for (const [name, id] of Object.entries(deployedIds)) {
    console.log(`  ${name}: ${id}`);
  }

  console.log("\ndocs/SOLANA_ALIEN_TEK.md updated with program IDs.");
  console.log("Commit with: git add docs/SOLANA_ALIEN_TEK.md && git commit -m 'feat: devnet alien tek program IDs'");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
