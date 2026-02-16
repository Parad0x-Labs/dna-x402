import path from "node:path";
import {
  CliRunResult,
  discoverProgramSoFiles,
  getAddress,
  getBalanceLamports,
  getBufferAccounts,
  hasFlag,
  maybeProgramIdKeypairForSo,
  nowStamp,
  parseFlagValue,
  parseRepeatedFlagValues,
  runSolana,
  stageFileToTemp,
  stageSignerPath,
  toSol,
  writeJson,
} from "./_solanaCli.js";

interface ProgramDeployLedger {
  programName: string;
  soPath: string;
  stagedSoPath?: string;
  stagedProgramIdKeypairPath?: string;
  programId?: string;
  deployCommand: string;
  deployStdout: string;
  deployStderr: string;
  success: boolean;
  error?: string;
  balanceBeforeLamports: string;
  balanceAfterLamports: string;
  deltaLamports: string;
  deltaSol: string;
  buffersBefore: string[];
  buffersAfter: string[];
  newBuffers: string[];
}

interface DeployLedgerReport {
  generatedAt: string;
  cluster: string;
  walletPubkey: string;
  keypair?: string;
  keypairUsedForDeploy?: string;
  upgradeAuthority?: string;
  upgradeAuthorityUsedForDeploy?: string;
  dryRun: boolean;
  programsRequested: string[];
  balanceBeforeLamports: string;
  balanceAfterLamports: string;
  totalDeltaLamports: string;
  totalDeltaSol: string;
  buffersBeforeAll: string[];
  buffersAfterAll: string[];
  allNewBuffers: string[];
  entries: ProgramDeployLedger[];
}

function usage(): string {
  return [
    "Usage: tsx scripts/deploy-ledger.ts [options]",
    "",
    "Options:",
    "  --cluster <devnet|testnet|mainnet-beta|url>   Cluster or RPC moniker (default: devnet)",
    "  --keypair <path>                                Deployer keypair path (default: Solana CLI default keypair)",
    "  --upgrade-authority <path>                      Upgrade authority signer (default: same as keypair/default)",
    "  --program <path/to/program.so>                  Program artifact path (repeatable).",
    "                                                  If omitted, autodiscovers target/deploy/*.so",
    "  --out <path>                                    Output JSON report path",
    "  --with-compute-unit-price <microlamports>       Optional priority fee for deploy txs",
    "  --final                                         Deploy as non-upgradeable",
    "  --dry-run                                       Print commands and generate report without deploying",
    "  --continue-on-error                             Continue deploying remaining programs after a failure",
    "  --help                                          Show this help",
  ].join("\n");
}

function detectProgramId(stdout: string, stderr: string): string | undefined {
  const merged = `${stdout}\n${stderr}`;

  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ["programId", "Program Id", "program_id"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 20) {
        return value;
      }
    }
  } catch {
    // non-json output; continue with regex
  }

  const match = merged.match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return match?.[1];
}

function computeDiff(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((value) => !beforeSet.has(value));
}

function main(): void {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const repoRoot = path.resolve(scriptDir, "..");
  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const keypair = parseFlagValue(argv, "--keypair");
  const upgradeAuthority = parseFlagValue(argv, "--upgrade-authority");
  const stagedKeypair = stageSignerPath(keypair);
  const stagedUpgradeAuthority = stageSignerPath(upgradeAuthority);
  const outPath = parseFlagValue(argv, "--out")
    ?? path.join(repoRoot, "reports", `deploy-ledger-${nowStamp()}.json`);
  const computeUnitPrice = parseFlagValue(argv, "--with-compute-unit-price");
  const dryRun = hasFlag(argv, "--dry-run");
  const continueOnError = hasFlag(argv, "--continue-on-error");
  const finalDeploy = hasFlag(argv, "--final");

  const requestedPrograms = parseRepeatedFlagValues(argv, "--program")
    .map((entry) => path.resolve(process.cwd(), entry));
  const discoveredPrograms = discoverProgramSoFiles(repoRoot);
  const programs = requestedPrograms.length > 0 ? requestedPrograms : discoveredPrograms;

  if (programs.length === 0) {
    throw new Error("No program artifacts found. Pass --program or build Rust artifacts into target/deploy/*.so.");
  }

  const context = { cluster, keypair: stagedKeypair };
  const walletPubkey = getAddress(context);
  const allBuffersBefore = getBufferAccounts(context);
  const balanceBefore = getBalanceLamports(walletPubkey, context);

  const entries: ProgramDeployLedger[] = [];

  for (const soPath of programs) {
    const programName = path.basename(soPath, ".so");
    const balanceProgramBefore = getBalanceLamports(walletPubkey, context);
    const buffersBefore = getBufferAccounts(context);

    const stagedSoPath = stageFileToTemp(soPath, ".so");

    const deployArgs = ["program", "deploy", stagedSoPath, "-u", cluster, "--output", "json-compact"];
    if (stagedKeypair) {
      deployArgs.push("-k", stagedKeypair);
    }
    if (stagedUpgradeAuthority) {
      deployArgs.push("--upgrade-authority", stagedUpgradeAuthority);
    }
    if (computeUnitPrice) {
      deployArgs.push("--with-compute-unit-price", computeUnitPrice);
    }
    if (finalDeploy) {
      deployArgs.push("--final");
    }

    const programIdKeypair = maybeProgramIdKeypairForSo(soPath);
    let stagedProgramIdKeypairPath: string | undefined;
    if (programIdKeypair) {
      stagedProgramIdKeypairPath = stageFileToTemp(programIdKeypair, ".json");
      deployArgs.push("--program-id", stagedProgramIdKeypairPath);
    }

    let result: CliRunResult;
    if (dryRun) {
      result = {
        status: 0,
        stdout: "dry-run: deployment skipped",
        stderr: "",
        cmd: `solana ${deployArgs.join(" ")}`,
      };
    } else {
      result = runSolana(deployArgs, repoRoot);
    }

    const balanceProgramAfter = getBalanceLamports(walletPubkey, context);
    const buffersAfter = getBufferAccounts(context);
    const delta = balanceProgramAfter - balanceProgramBefore;
    const newBuffers = computeDiff(buffersBefore, buffersAfter);

    const entry: ProgramDeployLedger = {
      programName,
      soPath,
      stagedSoPath,
      stagedProgramIdKeypairPath,
      programId: detectProgramId(result.stdout, result.stderr),
      deployCommand: result.cmd,
      deployStdout: result.stdout,
      deployStderr: result.stderr,
      success: result.status === 0,
      error: result.status === 0 ? undefined : `Deploy failed with exit code ${result.status}`,
      balanceBeforeLamports: balanceProgramBefore.toString(10),
      balanceAfterLamports: balanceProgramAfter.toString(10),
      deltaLamports: delta.toString(10),
      deltaSol: toSol(delta),
      buffersBefore,
      buffersAfter,
      newBuffers,
    };
    entries.push(entry);

    if (!entry.success && !continueOnError) {
      break;
    }
  }

  const allBuffersAfter = getBufferAccounts(context);
  const balanceAfter = getBalanceLamports(walletPubkey, context);
  const totalDelta = balanceAfter - balanceBefore;
  const allNewBuffers = computeDiff(allBuffersBefore, allBuffersAfter);

  const report: DeployLedgerReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    walletPubkey,
    keypair,
    keypairUsedForDeploy: stagedKeypair,
    upgradeAuthority,
    upgradeAuthorityUsedForDeploy: stagedUpgradeAuthority,
    dryRun,
    programsRequested: programs,
    balanceBeforeLamports: balanceBefore.toString(10),
    balanceAfterLamports: balanceAfter.toString(10),
    totalDeltaLamports: totalDelta.toString(10),
    totalDeltaSol: toSol(totalDelta),
    buffersBeforeAll: allBuffersBefore,
    buffersAfterAll: allBuffersAfter,
    allNewBuffers,
    entries,
  };

  writeJson(outPath, report);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: entries.every((entry) => entry.success),
    reportPath: outPath,
    cluster,
    walletPubkey,
    programs: entries.length,
    totalDeltaLamports: report.totalDeltaLamports,
    totalDeltaSol: report.totalDeltaSol,
    allNewBuffers: report.allNewBuffers.length,
  }, null, 2));

  if (!entries.every((entry) => entry.success)) {
    process.exitCode = 1;
  }
}

main();
