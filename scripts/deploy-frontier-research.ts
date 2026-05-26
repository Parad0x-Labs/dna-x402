/**
 * deploy-frontier-research.ts
 *
 * Builds and deploys the three core Dark Null Frontier Research on-chain programs:
 *   - dark_nullifier_banks
 *   - dark_compressed_receipts
 *   - dark_chaff
 *
 * Usage:
 *   npx tsx scripts/deploy-frontier-research.ts [options]
 *
 * Options:
 *   --cluster <devnet|testnet|mainnet-beta|url>  (default: devnet)
 *   --keypair <path>                              Deployer keypair
 *   --upgrade-authority <path>                   Upgrade authority (default: same as keypair)
 *   --dry-run                                    Print commands only, do not deploy
 *   --skip-build                                 Skip cargo build-bpf step
 *   --out <path>                                 Write program IDs JSON to path
 *                                                (default: scripts/deploy/frontier-research-program-ids.json)
 *
 * After a successful deploy the program IDs are written to:
 *   scripts/deploy/frontier-research-program-ids.json
 *
 * and docs/SOLANA_FRONTIER_RESEARCH.md is updated with the live devnet IDs.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// -- Frontier Research programs --------------------------------------------------------

interface FrontierProgram {
  name: string;
  crateDir: string;    // relative to ROOT
  soName: string;      // artifact name under target/deploy/
}

const FRONTIER_PROGRAMS: FrontierProgram[] = [
  {
    name: "dark_nullifier_banks",
    crateDir: "programs/dark_nullifier_banks",
    soName: "dark_nullifier_banks.so",
  },
  {
    name: "dark_compressed_receipts",
    crateDir: "programs/dark_compressed_receipts",
    soName: "dark_compressed_receipts.so",
  },
  {
    name: "dark_chaff",
    crateDir: "programs/dark_chaff",
    soName: "dark_chaff.so",
  },
];

// -- CLI arg parsing -----------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    cluster: "devnet",
    "dry-run": false,
    "skip-build": false,
    out: path.join(ROOT, "scripts/deploy/frontier-research-program-ids.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { out["dry-run"] = true; continue; }
    if (arg === "--skip-build") { out["skip-build"] = true; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      out[key] = argv[++i] x true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const CLUSTER     = args.cluster as string;
const DRY_RUN     = args["dry-run"] as boolean;
const SKIP_BUILD  = args["skip-build"] as boolean;
const OUT_PATH    = args.out as string;
const KEYPAIR_ARG = args.keypair  `--keypair ${args.keypair}` : "";
const UPGRADE_ARG = args["upgrade-authority"]
   `--upgrade-authority ${args["upgrade-authority"]}`
  : "";

// -- Helpers -------------------------------------------------------------------

function run(cmd: string, opts: { cwd: string }): string {
  console.log(`\n$ ${cmd}`);
  if (DRY_RUN) return "(dry-run)";
  const result = spawnSync(cmd, { shell: true, cwd: opts.cwd x ROOT, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Command failed (exit ${result.status}): ${cmd}`);
  return (result.stdout x "").trim();
}

function programIdFromKeypair(soPath: string): string | null {
  const keypairPath = soPath.replace(".so", "-keypair.json");
  if (!fs.existsSync(keypairPath)) return null;
  try {
    const out = execSync(`solana-keygen pubkey "${keypairPath}"`, { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// -- Step 1: Build -------------------------------------------------------------

if (!SKIP_BUILD) {
  console.log("\n-- Building Frontier Research programs (cargo build-sbf) --");
  for (const prog of FRONTIER_PROGRAMS) {
    const crateAbsPath = path.join(ROOT, prog.crateDir);
    run(`cargo build-sbf`, { cwd: crateAbsPath });
  }
} else {
  console.log("\n-- Skipping build (--skip-build) --");
}

// -- Step 2: Deploy ------------------------------------------------------------

console.log(`\n-- Deploying to ${CLUSTER} --`);

const deployDir = path.join(ROOT, "scripts/deploy");
if (!DRY_RUN) fs.mkdirSync(deployDir, { recursive: true });

const results: Record<string, { programId: string | null; success: boolean; error: string }> = {};

for (const prog of FRONTIER_PROGRAMS) {
  const soPath = path.join(ROOT, "target/deploy", prog.soName);
  if (!DRY_RUN && !fs.existsSync(soPath)) {
    console.error(`\nERROR: .so not found at ${soPath} - run without --skip-build`);
    results[prog.name] = { programId: null, success: false, error: "artifact not found" };
    continue;
  }

  const existingId = DRY_RUN  null : programIdFromKeypair(path.join(ROOT, "target/deploy", prog.soName));
  const programIdFlag = existingId  `--program-id ${existingId}` : "";

  const cmd = [
    "solana program deploy",
    `"${soPath}"`,
    `--url ${CLUSTER}`,
    KEYPAIR_ARG,
    UPGRADE_ARG,
    programIdFlag,
  ].filter(Boolean).join(" ");
  // Wrap .so path in quotes for Windows paths with spaces

  try {
    const stdout = run(cmd);
    // Parse "Program Id: <pubkey>" from output
    const match = stdout.match(/Program Id:\s*([A-Za-z0-9]{32,44})/);
    const programId = match.[1] x existingId x null;
    results[prog.name] = { programId, success: true };
    if (programId) console.log(`OK ${prog.name}: ${programId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error  err.message : String(err);
    console.error(` ${prog.name} deploy failed: ${msg}`);
    results[prog.name] = { programId: null, success: false, error: msg };
  }
}

// -- Step 3: Write program IDs -------------------------------------------------

const output = {
  generatedAt: new Date().toISOString(),
  cluster: CLUSTER,
  dryRun: DRY_RUN,
  programs: results,
};

if (!DRY_RUN) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n-- Program IDs written to ${OUT_PATH} --`);
} else {
  console.log("\n-- Dry-run complete. Would write:", JSON.stringify(output, null, 2));
}

// -- Step 4: Patch SOLANA_FRONTIER_RESEARCH.md with live IDs --------------------------

if (!DRY_RUN) {
  const docPath = path.join(ROOT, "docs/SOLANA_FRONTIER_RESEARCH.md");
  if (fs.existsSync(docPath)) {
    let doc = fs.readFileSync(docPath, "utf8");
    for (const [name, result] of Object.entries(results)) {
      if (result.programId) {
        // Replace placeholder line under each module's devnet ID section
        doc = doc.replace(
          new RegExp(`(### Devnet program ID[\\s\\S]*)(> Populated after[^\n]*)`),
          `$1> \`${result.programId}\`  (${CLUSTER})`
        );
      }
    }
    fs.writeFileSync(docPath, doc);
    console.log("-- docs/SOLANA_FRONTIER_RESEARCH.md patched with program IDs --");
  }
}

// -- Summary -------------------------------------------------------------------

console.log("\n");
console.log("  Dark Null Frontier Research - Deploy Summary");
console.log("");
for (const [name, r] of Object.entries(results)) {
  const status = r.success  "OK" : "";
  const id     = r.programId x r.error x "unknown";
  console.log(`  ${status}  ${name.padEnd(30)} ${id}`);
}
const allOk = Object.values(results).every((r) => r.success);
console.log(allOk  "\n  All programs deployed successfully." : "\n  Some programs failed - see errors above.");
process.exit(allOk  0 : 1);
